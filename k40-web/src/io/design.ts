/**
 * Laden von SVG- und Bilddateien im Browser – ersetzt Inkscape.
 *  - Rot (#FF0000) umrandete Objekte  -> Vektor-Schnitt
 *  - Blau (#0000FF) umrandete Objekte -> Vektor-Gravur
 *  - alles andere                     -> Raster-Gravur (vom Browser gerendert)
 */
import { ellipsePath, flattenPath, pointsPath, rectPath, type Mat, type Polyline } from '../core/pathFlatten';
import type { GrayRaster } from '../core/job';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MM_PER_IN = 25.4;

export interface DesignOptions {
  mirror: boolean;
  rotate: boolean;
  /** Auflösung für PNG/JPG und SVG ohne Einheiten */
  imageDpi: number;
}

export interface Design {
  name: string;
  widthMm: number;
  heightMm: number;
  cut: Polyline[];
  engrave: Polyline[];
  hasRaster: boolean;
  /** SVG-Dokument nur mit Rasterinhalt (Schnitt-/Gravurlinien entfernt) */
  rasterSvg: Document;
  /** Vorschau des Rasterinhalts */
  preview: HTMLCanvasElement | null;
  warnings: string[];
}

function lengthToMm(v: string | null, pxPerIn: number): number | null {
  if (!v) return null;
  const m = v.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'mm':
      return n;
    case 'cm':
      return n * 10;
    case 'in':
      return n * MM_PER_IN;
    case 'pt':
      return (n / 72) * MM_PER_IN;
    case 'pc':
      return (n / 6) * MM_PER_IN;
    case '':
    case 'px':
      return (n / pxPerIn) * MM_PER_IN;
    default:
      return null; // % u.ä.
  }
}

/** <use>-Elemente durch Kopien ersetzen, damit Stil und Geometrie direkt zugänglich sind. */
function expandUses(doc: Document) {
  for (let pass = 0; pass < 10; pass++) {
    const uses = Array.from(doc.getElementsByTagNameNS(SVG_NS, 'use'));
    if (!uses.length) return;
    for (const use of uses) {
      const href = use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href') ?? '';
      const target = href.startsWith('#') ? doc.getElementById(href.slice(1)) : null;
      const g = doc.createElementNS(SVG_NS, 'g');
      for (const a of Array.from(use.attributes)) {
        if (['x', 'y', 'width', 'height', 'href', 'id'].includes(a.localName)) continue;
        g.setAttribute(a.name, a.value);
      }
      const x = parseFloat(use.getAttribute('x') ?? '0') || 0;
      const y = parseFloat(use.getAttribute('y') ?? '0') || 0;
      const t = use.getAttribute('transform') ?? '';
      g.setAttribute('transform', `${t} translate(${x},${y})`);
      if (target && !target.contains(use)) {
        let clone = target.cloneNode(true) as Element;
        if (clone.localName === 'symbol') {
          const sg = doc.createElementNS(SVG_NS, 'g');
          while (clone.firstChild) sg.appendChild(clone.firstChild);
          clone = sg;
        }
        clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
        g.appendChild(clone);
      }
      use.replaceWith(g);
    }
  }
}

function parseColor(c: string): [number, number, number] | null {
  const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

function classify(stroke: string): 'cut' | 'engrave' | null {
  const c = parseColor(stroke);
  if (!c) return null;
  const [r, g, b] = c;
  const d = 10;
  if (r >= 255 - d && g <= d && b <= d) return 'cut';
  if (r <= d && g <= d && b >= 255 - d) return 'engrave';
  return null;
}

function geometryPath(el: Element): string {
  const num = (n: string) => {
    const a = (el as any)[n] as SVGAnimatedLength | undefined;
    return a?.baseVal ? a.baseVal.value : parseFloat(el.getAttribute(n) ?? '0') || 0;
  };
  switch (el.localName) {
    case 'path':
      return el.getAttribute('d') ?? '';
    case 'rect': {
      const rxAttr = el.getAttribute('rx');
      const ryAttr = el.getAttribute('ry');
      return rectPath(num('x'), num('y'), num('width'), num('height'), rxAttr ? num('rx') : -1, ryAttr ? num('ry') : -1);
    }
    case 'circle':
      return ellipsePath(num('cx'), num('cy'), num('r'), num('r'));
    case 'ellipse':
      return ellipsePath(num('cx'), num('cy'), num('rx'), num('ry'));
    case 'line':
      return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`;
    case 'polyline':
      return pointsPath(el.getAttribute('points') ?? '', false);
    case 'polygon':
      return pointsPath(el.getAttribute('points') ?? '', true);
    default:
      return '';
  }
}

const NON_RENDERED = new Set(['defs', 'clipPath', 'mask', 'marker', 'pattern', 'symbol', 'metadata', 'title', 'desc']);

function isRendered(el: Element, root: Element): boolean {
  for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
    if (NON_RENDERED.has(e.localName)) return false;
    if (getComputedStyle(e).display === 'none') return false;
  }
  return getComputedStyle(el).visibility !== 'hidden';
}

/** Baut das normierte Dokument: Wurzel in mm (viewBox 0 0 W H), Original darin verschachtelt. */
function normalize(text: string, opts: DesignOptions): { doc: Document; W: number; H: number; warnings: string[] } {
  const warnings: string[] = [];
  const src = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (src.getElementsByTagName('parsererror').length) throw new Error('Die SVG-Datei konnte nicht gelesen werden.');
  const orig = src.documentElement;
  if (orig.localName !== 'svg') throw new Error('Keine SVG-Datei.');
  expandUses(src);

  const vbAttr = orig.getAttribute('viewBox');
  const vb = vbAttr ? vbAttr.trim().split(/[\s,]+/).map(Number) : null;
  let wMm = lengthToMm(orig.getAttribute('width'), opts.imageDpi === 0 ? 96 : 96);
  let hMm = lengthToMm(orig.getAttribute('height'), 96);
  const unitless = !/[a-z]/i.test(orig.getAttribute('width') ?? 'x');
  if (wMm === null && vb) wMm = (vb[2] / 96) * MM_PER_IN;
  if (hMm === null && vb) hMm = (vb[3] / 96) * MM_PER_IN;
  if (wMm === null || hMm === null || !(wMm > 0) || !(hMm > 0)) throw new Error('Größe der SVG-Datei nicht bestimmbar (width/height/viewBox fehlen).');
  if (unitless) warnings.push('SVG ohne Maßeinheit – es werden 96 px/Zoll angenommen (Inkscape-Standard).');
  if (vb && Math.abs(vb[2] / vb[3] - wMm / hMm) > 0.01 * (wMm / hMm)) warnings.push('Seitenverhältnis von viewBox und Größe weichen ab.');

  const W = opts.rotate ? hMm : wMm;
  const H = opts.rotate ? wMm : hMm;
  const doc = document.implementation.createDocument(SVG_NS, 'svg', null);
  const root = doc.documentElement;
  root.setAttribute('xmlns', SVG_NS);
  root.setAttribute('xmlns:xlink', XLINK_NS);
  root.setAttribute('width', `${W}mm`);
  root.setAttribute('height', `${H}mm`);
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const g = doc.createElementNS(SVG_NS, 'g');
  // Spiegeln (horizontal) und Drehen (90° im Uhrzeigersinn)
  let t = '';
  if (opts.rotate) t += `translate(${W} 0) rotate(90) `;
  if (opts.mirror) t += `translate(${wMm} 0) scale(-1 1)`;
  if (t) g.setAttribute('transform', t.trim());
  root.appendChild(g);
  const inner = doc.importNode(orig, true) as Element;
  inner.setAttribute('x', '0');
  inner.setAttribute('y', '0');
  inner.setAttribute('width', String(wMm));
  inner.setAttribute('height', String(hMm));
  if (!vb) {
    const pxW = (wMm / MM_PER_IN) * 96;
    const pxH = (hMm / MM_PER_IN) * 96;
    inner.setAttribute('viewBox', `0 0 ${pxW} ${pxH}`);
  }
  inner.setAttribute('overflow', 'visible');
  g.appendChild(inner);
  return { doc, W, H, warnings };
}

let host: HTMLElement | null = null;
function mountHost(): ShadowRoot {
  if (!host) {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-20000px;top:0;width:10px;height:10px;opacity:0;pointer-events:none;overflow:hidden';
    host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
  }
  return host.shadowRoot!;
}

function matOf(m: DOMMatrix): Mat {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

export async function loadSvg(name: string, text: string, opts: DesignOptions): Promise<Design> {
  const { doc, W, H, warnings } = normalize(text, opts);
  const shadow = mountHost();
  shadow.replaceChildren();
  const live = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  live.setAttribute('width', '1000px');
  live.setAttribute('height', `${(1000 * H) / W}px`);
  shadow.appendChild(live);

  const cut: Polyline[] = [];
  const engrave: Polyline[] = [];
  const toStrip: number[] = [];
  let textWithColor = 0;
  let externalImages = 0;
  const rootInv = live.getScreenCTM()?.inverse();
  if (!rootInv) throw new Error('Interner Fehler: SVG konnte nicht ausgemessen werden.');

  const all = Array.from(live.querySelectorAll('*'));
  all.forEach((el, idx) => {
    if (el.localName === 'image') {
      const href = el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href') ?? '';
      if (href && !href.startsWith('data:')) externalImages++;
    }
    const kind = classify(getComputedStyle(el).stroke);
    if (!kind) return;
    if (el.localName === 'text' || el.localName === 'tspan' || el.localName === 'textPath') {
      textWithColor++;
      toStrip.push(idx);
      return;
    }
    if (!(el instanceof SVGGeometryElement)) return;
    toStrip.push(idx);
    if (!isRendered(el, live)) return;
    const ctm = (el as SVGGraphicsElement).getScreenCTM();
    if (!ctm) return;
    const m = matOf(rootInv.multiply(ctm));
    const d = geometryPath(el);
    if (!d) return;
    try {
      const polys = flattenPath(d, m, 0.01);
      (kind === 'cut' ? cut : engrave).push(...polys);
    } catch {
      warnings.push(`Pfad konnte nicht gelesen werden (${el.localName}).`);
    }
  });
  if (textWithColor) warnings.push(`${textWithColor} Text(e) mit roter/blauer Kontur gefunden – Texte bitte in Inkscape/Illustrator in Pfade umwandeln, sonst werden sie nicht geschnitten.`);
  if (externalImages) warnings.push(`${externalImages} extern verlinkte(s) Bild(er) können nicht geladen werden – bitte Bilder in die SVG einbetten.`);

  // Rasterdokument: Konturen der Schnitt-/Gravurobjekte entfernen (Füllungen bleiben wie im Original)
  const docAll = Array.from(doc.documentElement.querySelectorAll('*'));
  for (const idx of toStrip) {
    const e = docAll[idx] as SVGElement | undefined;
    if (e) {
      const style = e.getAttribute('style') ?? '';
      e.setAttribute('style', `${style};stroke:none !important`);
    }
  }
  shadow.replaceChildren();

  const preview = await renderPreview(doc, W, H, 6);
  const hasRaster = canvasHasInk(preview);
  return { name, widthMm: W, heightMm: H, cut, engrave, hasRaster, rasterSvg: doc, preview: hasRaster ? preview : null, warnings };
}

export async function loadImage(name: string, file: Blob, opts: DesignOptions): Promise<Design> {
  const url = await blobToDataUrl(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const wMm = (img.naturalWidth / opts.imageDpi) * MM_PER_IN;
  const hMm = (img.naturalHeight / opts.imageDpi) * MM_PER_IN;
  const svg = `<svg xmlns="${SVG_NS}" width="${wMm}mm" height="${hMm}mm" viewBox="0 0 ${wMm} ${hMm}"><image href="${url}" x="0" y="0" width="${wMm}" height="${hMm}" preserveAspectRatio="none"/></svg>`;
  const d = await loadSvg(name, svg, opts);
  d.warnings = d.warnings.filter((w) => !w.includes('96 px'));
  return d;
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

async function svgToImage(doc: Document): Promise<HTMLImageElement> {
  const text = new XMLSerializer().serializeToString(doc);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // nach decode() ist das Bild im Speicher
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function renderPreview(doc: Document, W: number, H: number, pxPerMm: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(pxPerMm, 4000 / Math.max(W, H));
  const cw = Math.max(1, Math.round(W * scale));
  const chh = Math.max(1, Math.round(H * scale));
  const d = doc.cloneNode(true) as Document;
  const root = d.documentElement;
  root.setAttribute('width', `${cw}px`);
  root.setAttribute('height', `${chh}px`);
  const img = await svgToImage(d);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = chh;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, chh);
  ctx.drawImage(img, 0, 0, cw, chh);
  return c;
}

function canvasHasInk(c: HTMLCanvasElement): boolean {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) return true;
  return false;
}

/**
 * Rendert den Rasterinhalt in Streifen: 1 Pixel = 1/1000 Zoll horizontal, eine Zeile pro Scanlinie.
 * Jede Zeile mittelt über ihre Zeilenhöhe (das SVG wird dafür nicht-proportional skaliert).
 */
export async function renderRaster(
  design: Design,
  stepMils: number,
  scaleX: number,
  scaleY: number,
  onProgress?: (f: number) => void,
): Promise<GrayRaster> {
  const W = design.widthMm;
  const H = design.heightMm;
  const width = Math.max(1, Math.round((W / MM_PER_IN) * 1000 * scaleX));
  const rows = Math.max(1, Math.floor(((H / MM_PER_IN) * 1000 * scaleY) / stepMils));
  const rowMm = (stepMils / 1000) * MM_PER_IN / scaleY;
  const gray = new Uint8Array(width * rows);
  const stripRows = Math.max(1, Math.min(rows, Math.floor(6_000_000 / width)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = stripRows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const d = design.rasterSvg.cloneNode(true) as Document;
  const root = d.documentElement;
  root.setAttribute('preserveAspectRatio', 'none');
  root.setAttribute('width', `${width}px`);
  for (let r0 = 0; r0 < rows; r0 += stripRows) {
    const n = Math.min(stripRows, rows - r0);
    root.setAttribute('height', `${n}px`);
    root.setAttribute('viewBox', `0 ${r0 * rowMm} ${W} ${n * rowMm}`);
    const img = await svgToImage(d);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, stripRows);
    ctx.drawImage(img, 0, 0, width, n);
    const px = ctx.getImageData(0, 0, width, n).data;
    const base = r0 * width;
    for (let i = 0, j = 0; j < width * n; i += 4, j++) {
      gray[base + j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    }
    onProgress?.(Math.min(1, (r0 + n) / rows));
  }
  return { width, rows, stepMils, gray };
}
