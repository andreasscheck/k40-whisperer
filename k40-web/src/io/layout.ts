/**
 * Mehrere Objekte (Dateien und Formen) auf dem Arbeitsbereich und ihre Zusammenführung
 * zu einem Auftrag. Positionen in mm, Ursprung oben links, y nach unten.
 */
import { flattenPath, type Polyline } from '../core/pathFlatten';
import type { ExtraPart, RasterBits } from '../core/job';
import { SHAPE_NAMES, TEST_FONT_MM, fmtNum, shapeOutline, squarePoly, testLayout, type Shape, type TestField } from '../core/shapes';
import { loadSvg, type Design } from './design';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MM_PER_IN = 25.4;

export interface Item {
  id: number;
  name: string;
  /** linke obere Ecke auf dem Arbeitsbereich (mm) */
  x: number;
  y: number;
  design: Design;
  /** steigt bei jeder inhaltlichen Änderung (für Caches) */
  version: number;
  file?: File;
  shape?: Shape;
  /** Testmuster: Felder mit eigener Geschwindigkeit */
  fields?: TestField[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function itemBox(it: Item): Box {
  return { x: it.x, y: it.y, w: it.design.widthMm, h: it.design.heightMm };
}

export function unionBox(items: Item[]): Box | null {
  if (!items.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    const b = itemBox(it);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function svgText(w: number, h: number, body: string): string {
  return `<svg xmlns="${SVG_NS}" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

const OPTS = { mirror: false, rotate: false, imageDpi: 96 };

function emptyDoc(): Document {
  return document.implementation.createDocument(SVG_NS, 'svg', null);
}

/** Erzeugt Design (und ggf. Testfelder) einer Form. */
export async function buildShapeDesign(shape: Shape): Promise<{ design: Design; fields?: TestField[] }> {
  const name = SHAPE_NAMES[shape.kind];
  if (shape.kind === 'test') {
    const { fields, w, h } = testLayout(shape);
    const labels = shape.labels
      ? fields
          .map((f) => `<text x="${f.x + f.size / 2}" y="${f.size + TEST_FONT_MM + 0.6}" font-family="Helvetica, Arial, sans-serif" font-size="${TEST_FONT_MM}" text-anchor="middle" fill="#000">${fmtNum(f.feed)}</text>`)
          .join('')
      : '';
    const squares = shape.mode === 'raster' ? fields.map((f) => `<rect x="${f.x}" y="${f.y}" width="${f.size}" height="${f.size}" fill="#000"/>`).join('') : '';
    const full = await loadSvg(name, svgText(w, h, squares + labels), OPTS);
    const lab = await loadSvg(name, svgText(w, h, labels), OPTS);
    const engrave = shape.mode === 'vector' ? fields.map((f) => squarePoly(f.x, f.y, f.size)) : [];
    return {
      design: { ...full, cut: [], engrave, rasterSvg: lab.rasterSvg, hasRaster: lab.hasRaster, warnings: [] },
      fields,
    };
  }
  const o = shapeOutline(shape);
  if (shape.op === 'fill') {
    const d = await loadSvg(name, svgText(o.w, o.h, `<path d="${o.d}" fill="#000" fill-rule="evenodd"/>`), OPTS);
    return { design: { ...d, warnings: [] } };
  }
  const polys = flattenPath(o.d, undefined, 0.01);
  return {
    design: {
      name,
      widthMm: o.w,
      heightMm: o.h,
      cut: shape.op === 'cut' ? polys : [],
      engrave: shape.op === 'engrave' ? polys : [],
      hasRaster: false,
      rasterSvg: emptyDoc(),
      preview: null,
      warnings: [],
    },
  };
}

const shift = (polys: Polyline[], dx: number, dy: number): Polyline[] => polys.map((p) => p.map(([x, y]) => [x + dx, y + dy] as [number, number]));

/** Schnitt- und Gravurlinien aller Objekte relativ zum Auftragsursprung. */
export function composeVectors(items: Item[], ox: number, oy: number): { cut: Polyline[]; engrave: Polyline[] } {
  const cut: Polyline[] = [];
  const engrave: Polyline[] = [];
  for (const it of items) {
    if (it.fields && it.shape?.kind === 'test') continue; // Testfelder laufen mit eigener Geschwindigkeit
    cut.push(...shift(it.design.cut, it.x - ox, it.y - oy));
    engrave.push(...shift(it.design.engrave, it.x - ox, it.y - oy));
  }
  return { cut, engrave };
}

export interface ScaleSettings {
  scaleX: number;
  scaleY: number;
  rasterStepMils: number;
}

const toMilsX = (mm: number, s: ScaleSettings) => (mm / MM_PER_IN) * 1000 * s.scaleX;
const toMilsY = (mm: number, s: ScaleSettings) => (mm / MM_PER_IN) * 1000 * s.scaleY;

/** Testfelder als Zusatzteile mit eigener Geschwindigkeit. */
export function composeExtras(items: Item[], ox: number, oy: number, s: ScaleSettings): ExtraPart[] {
  const out: ExtraPart[] = [];
  const step = Math.max(1, Math.round(s.rasterStepMils));
  for (const it of items) {
    if (!it.fields || it.shape?.kind !== 'test') continue;
    for (const f of it.fields) {
      const fx = it.x + f.x - ox;
      const fy = it.y + f.y - oy;
      if (it.shape.mode === 'vector') {
        out.push({ op: 'engrave', feed: f.feed, polys: [squarePoly(fx, fy, f.size)] });
      } else {
        const width = Math.max(1, Math.round(toMilsX(f.size, s)));
        const rows = Math.max(1, Math.floor(toMilsY(f.size, s) / step));
        const bits: RasterBits = {
          width,
          rows,
          stepMils: step,
          bits: new Uint8Array(width * rows).fill(1),
          offsetX: Math.round(toMilsX(fx, s)),
          offsetY: Math.round(toMilsY(fy, s) / step) * step,
        };
        out.push({ op: 'raster', feed: f.feed, bits });
      }
    }
  }
  return out;
}

export interface RasterComposite {
  /** für renderRaster */
  design: Pick<Design, 'widthMm' | 'heightMm' | 'rasterSvg'>;
  /** Lage relativ zum Auftragsursprung (1/1000 Zoll, skaliert) */
  offsetX: number;
  offsetY: number;
  /** Schlüssel für den Cache */
  key: string;
}

/**
 * Fasst den Rasterinhalt aller Objekte in einem SVG zusammen. Die linke obere Ecke liegt
 * genau auf einem Vielfachen des Zeilenabstands (relativ zum Auftragsursprung).
 */
export function composeRaster(items: Item[], ox: number, oy: number, s: ScaleSettings): RasterComposite | null {
  const ras = items.filter((it) => it.design.hasRaster);
  const box = unionBox(ras);
  if (!box) return null;
  const step = Math.max(1, Math.round(s.rasterStepMils));
  const offsetX = Math.floor(toMilsX(box.x - ox, s));
  const offsetY = Math.floor(toMilsY(box.y - oy, s) / step) * step;
  const rx = ox + ((offsetX / 1000) * MM_PER_IN) / s.scaleX;
  const ry = oy + ((offsetY / 1000) * MM_PER_IN) / s.scaleY;
  const W = box.x + box.w - rx;
  const H = box.y + box.h - ry;
  const doc = document.implementation.createDocument(SVG_NS, 'svg', null);
  const root = doc.documentElement;
  root.setAttribute('width', `${W}mm`);
  root.setAttribute('height', `${H}mm`);
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  for (const it of ras) {
    const inner = doc.importNode(it.design.rasterSvg.documentElement, true) as Element;
    inner.setAttribute('x', String(it.x - rx));
    inner.setAttribute('y', String(it.y - ry));
    inner.setAttribute('width', String(it.design.widthMm));
    inner.setAttribute('height', String(it.design.heightMm));
    root.appendChild(inner);
  }
  const key = ras.map((it) => `${it.id}.${it.version}@${(it.x - ox).toFixed(4)},${(it.y - oy).toFixed(4)}`).join(';');
  return { design: { widthMm: W, heightMm: H, rasterSvg: doc }, offsetX, offsetY, key };
}
