import { EgvWriter, egvFileContent } from './core/egv';
import { simulateEgv, type SimResult } from './core/egvSim';
import { DEFAULT_JOB, buildJob, grayToBits, type GrayRaster, type JobOps, type RasterBits } from './core/job';
import type { BoardName } from './core/laserSpeed';
import type { Polyline } from './core/pathFlatten';
import { SHAPE_NAMES, TEST_SPEEDS, defaultShape, type RectShape, type Shape } from './core/shapes';
import { loadImage, loadSvg, renderRaster, type Design } from './io/design';
import { buildShapeDesign, composeExtras, composeRaster, composeVectors, itemBox, unionBox, type Box, type Item } from './io/layout';
import { AbortedError, K40Usb, STATUS } from './usb/k40usb';

// ------------------------------------------------------------------ Einstellungen

const DEFAULTS = {
  ...DEFAULT_JOB,
  bedW: 325,
  bedH: 220,
  jogStep: 10,
  rasterMode: 'threshold' as 'threshold' | 'dither',
  threshold: 128,
  gamma: 1,
  invert: false,
  mirror: false,
  rotate: false,
  imageDpi: 300,
  waitFinish: true,
  timeoutMs: 200,
  showSim: false,
};
type Settings = typeof DEFAULTS;
const KEY = 'k40web.settings.v1';

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
const S: Settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch {
    /* privates Fenster o.ä. */
  }
}

// ------------------------------------------------------------------ Zustand

const MIL_PER_MM = 1000 / 25.4;
/** Objekte auf dem Arbeitsbereich (Dateien und Formen), in Zeichenreihenfolge */
let items: Item[] = [];
let selectedId: number | null = null;
let nextId = 1;
const buildTokens = new Map<number, number>();
let laser: K40Usb | null = null;
/** aktuelle Kopfposition (1/1000 Zoll, y nach unten) */
const head = { x: 0, y: 0 };
let homed = false;
/** Antwortet der Controller auf Statusabfragen? null = unbekannt */
let responsive: boolean | null = null;
let polling = false;
let autoConnecting = false;
let busy = false;
let abortRequested = false;
let paused = false;
let grayCache: { key: string; gray: GrayRaster } | null = null;
let bitsCache: { key: string; bits: RasterBits } | null = null;
let simCache: { key: string; sim: SimResult } | null = null;
let motion: Promise<unknown> = Promise.resolve();

const selected = () => items.find((it) => it.id === selectedId) ?? null;
const jobBox = (): Box | null => unionBox(items);
const isFrame = (it: Item) => it.shape?.kind === 'rect' && !!it.shape.frame;

// ------------------------------------------------------------------ DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const stage = $('stage');

function setStatus(text: string, kind: '' | 'error' | 'warn' | 'busy' = '') {
  $('statusText').textContent = text;
  $('statusText').title = text;
  $('statusBar').className = 'status' + (kind ? ' ' + kind : '');
}
function setProgress(f: number | null) {
  $('progress').style.width = f === null ? '0' : `${Math.round(f * 100)}%`;
}
const fmt1 = (mm: number) => mm.toFixed(1).replace('.', ',');
const fmtMm = (mils: number) => fmt1(mils / MIL_PER_MM);
const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.round(s - m * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(ss).padStart(2, '0')} min`;
};

// ------------------------------------------------------------------ Einstellungen <-> Formular

const numFields: (keyof Settings)[] = ['rasterFeed', 'rasterPasses', 'engraveFeed', 'engravePasses', 'cutFeed', 'cutPasses', 'bedW', 'bedH', 'jogStep', 'gamma', 'imageDpi', 'scaleX', 'scaleY', 'timeoutMs', 'threshold'];
const boolFields: (keyof Settings)[] = ['invert', 'rasterBottomUp', 'mirror', 'rotate', 'insideFirst', 'waitFinish', 'showSim'];
const idOf: Partial<Record<keyof Settings, string>> = { rasterBottomUp: 'bottomUp' };
const reloadOn = new Set<keyof Settings>(['mirror', 'rotate', 'imageDpi']);

function bindSettings() {
  for (const k of numFields) {
    const el = $<HTMLInputElement>(idOf[k] ?? k);
    el.value = String(S[k]);
    el.addEventListener('change', () => {
      const v = parseFloat(el.value.replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0) {
        el.value = String(S[k]);
        return;
      }
      (S as any)[k] = ['rasterPasses', 'engravePasses', 'cutPasses'].includes(k) ? Math.max(1, Math.round(v)) : v;
      el.value = String(S[k]);
      onSettingsChanged(k);
    });
  }
  for (const k of boolFields) {
    const el = $<HTMLInputElement>(idOf[k] ?? k);
    el.checked = Boolean(S[k]);
    el.addEventListener('change', () => {
      (S as any)[k] = el.checked;
      onSettingsChanged(k);
    });
  }
  const sel = (id: string, k: keyof Settings, conv: (v: string) => unknown) => {
    const el = $<HTMLSelectElement>(id);
    el.value = String(S[k]);
    el.addEventListener('change', () => {
      (S as any)[k] = conv(el.value);
      onSettingsChanged(k);
    });
  };
  sel('board', 'board', (v) => v as BoardName);
  sel('rasterStep', 'rasterStepMils', (v) => parseInt(v, 10));
  sel('rasterMode', 'rasterMode', (v) => v);
}

function onSettingsChanged(k: keyof Settings) {
  saveSettings();
  if (k === 'timeoutMs' && laser) laser.timeoutMs = S.timeoutMs;
  if (reloadOn.has(k) && items.some((it) => it.file)) {
    void reloadFiles();
    return;
  }
  if (k === 'bedW' || k === 'bedH') items.forEach(clampItem);
  refreshAll();
}

/** Nach jeder Änderung an Objekten oder Einstellungen */
function refreshAll() {
  renderList();
  updateInfo();
  updateButtons();
  draw();
  if (S.showSim) void refreshSim();
}

// ------------------------------------------------------------------ Dateien

async function loadFileDesign(file: File): Promise<Design> {
  const opts = { mirror: S.mirror, rotate: S.rotate, imageDpi: S.imageDpi };
  const isSvg = file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml';
  return isSvg ? loadSvg(file.name, await file.text(), opts) : loadImage(file.name, file, opts);
}

/**
 * Dateien laden. replace = bisher geladene Dateien ersetzen (Formen bleiben),
 * die neue Datei übernimmt die Position der alten.
 */
async function openFiles(files: File[], replace: boolean) {
  if (busy || !files.length) return;
  const loaded: { file: File; design: Design }[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    setStatus(`Lade ${file.name} …`, 'busy');
    try {
      const design = await loadFileDesign(file);
      loaded.push({ file, design });
      warnings.push(...design.warnings.map((w) => (files.length > 1 ? `${file.name}: ${w}` : w)));
    } catch (e) {
      warnings.push(`${file.name} konnte nicht geladen werden: ${(e as Error).message}`);
    }
  }
  if (!loaded.length) {
    showWarnings([]);
    setStatus(warnings[0] ?? 'Datei konnte nicht geladen werden.', 'error');
    return;
  }
  const old = replace ? items.filter((it) => it.file) : [];
  const keepPos = old[0] ? { x: old[0].x, y: old[0].y } : null;
  if (replace) items = items.filter((it) => !it.file);
  const added: Item[] = [];
  for (const { file, design } of loaded) {
    const it: Item = { id: nextId++, name: file.name, x: 0, y: 0, design, version: 1, file };
    if (keepPos && !added.length) {
      it.x = keepPos.x;
      it.y = keepPos.y;
      clampItem(it);
    } else {
      placeFree(it);
    }
    items.push(it);
    added.push(it);
  }
  // Rahmen um die ersetzte Datei gehören jetzt zur neuen
  for (const fr of items) {
    if (fr.shape?.kind === 'rect' && fr.shape.frame && old.some((o) => o.id === (fr.shape as RectShape).frame!.target)) {
      (fr.shape as RectShape).frame!.target = added[0].id;
    }
  }
  selectedId = added[0].id;
  await refitFrames();
  setOpsFromContent();
  showWarnings(warnings);
  setStatus(loaded.length === 1 ? `${loaded[0].file.name} geladen.` : `${loaded.length} Dateien geladen.`, warnings.some((w) => w.includes('nicht geladen')) ? 'warn' : '');
  renderEditor();
  refreshAll();
}

async function reloadFiles() {
  if (busy) return;
  const warnings: string[] = [];
  for (const it of items) {
    if (!it.file) continue;
    setStatus(`Lade ${it.file.name} …`, 'busy');
    try {
      it.design = await loadFileDesign(it.file);
      it.version++;
      clampItem(it);
      warnings.push(...it.design.warnings);
    } catch (e) {
      warnings.push(`${it.file.name} konnte nicht geladen werden: ${(e as Error).message}`);
    }
  }
  await refitFrames();
  showWarnings(warnings);
  setStatus('Dateien neu geladen.');
  renderEditor();
  refreshAll();
}

function showWarnings(w: string[]) {
  const el = $('warnings');
  el.hidden = w.length === 0;
  el.replaceChildren(
    ...w.map((t) => {
      const d = document.createElement('div');
      d.textContent = '⚠ ' + t;
      return d;
    }),
  );
}

// ------------------------------------------------------------------ Formen

async function rebuildShape(it: Item): Promise<boolean> {
  if (!it.shape) return false;
  const token = (buildTokens.get(it.id) ?? 0) + 1;
  buildTokens.set(it.id, token);
  try {
    const r = await buildShapeDesign(it.shape);
    if (buildTokens.get(it.id) !== token) return false; // inzwischen erneut geändert
    it.design = r.design;
    it.fields = r.fields;
    it.version++;
    return true;
  } catch (e) {
    setStatus(`Form konnte nicht erzeugt werden: ${(e as Error).message}`, 'error');
    return false;
  }
}

async function addShape(kind: Shape['kind']) {
  if (busy) return;
  const it: Item = { id: nextId++, name: SHAPE_NAMES[kind], x: 0, y: 0, design: null as unknown as Design, version: 0, shape: defaultShape(kind) };
  if (!(await rebuildShape(it))) return;
  placeFree(it);
  items.push(it);
  selectedId = it.id;
  setOpsFromContent();
  setStatus(`${it.name} hinzugefügt – Maße unter „Objekte“ einstellen, mit der Maus verschieben.`);
  renderEditor();
  refreshAll();
}

/** Rahmen um das ausgewählte Objekt (oder um alle Objekte) */
async function addFrame() {
  if (busy) return;
  const sel = selected();
  const target = sel && !isFrame(sel) ? sel : null;
  if (!items.some((o) => !isFrame(o))) {
    setStatus('Erst eine Datei laden oder eine Form hinzufügen – der Rahmen wird darum gelegt.', 'warn');
    return;
  }
  const shape: RectShape = { kind: 'rect', w: 10, h: 10, r: 0, op: 'cut', frame: { target: target?.id ?? null, margin: 3 } };
  const it: Item = { id: nextId++, name: 'Rahmen', x: 0, y: 0, design: null as unknown as Design, version: 0, shape };
  fitFrame(it);
  if (!(await rebuildShape(it))) return;
  items.push(it);
  selectedId = it.id;
  setOpsFromContent();
  setStatus(target ? `Rahmen um „${target.name}“ hinzugefügt (wird geschnitten).` : 'Rahmen um alle Objekte hinzugefügt (wird geschnitten).');
  renderEditor();
  refreshAll();
}

function frameTargets(fr: Item): Item[] {
  const f = (fr.shape as RectShape).frame!;
  const others = items.filter((o) => o !== fr && !isFrame(o));
  const t = f.target !== null ? others.filter((o) => o.id === f.target) : [];
  return t.length ? t : others;
}

/** Rahmengröße an das Zielobjekt anpassen; ggf. das Ziel verschieben, damit der Rahmen aufs Bett passt. */
function fitFrame(fr: Item) {
  const s = fr.shape as RectShape;
  const m = s.frame!.margin;
  const targets = frameTargets(fr);
  const b = unionBox(targets);
  if (!b) return;
  const dx = Math.max(0, m - b.x);
  const dy = Math.max(0, m - b.y);
  if (dx || dy) for (const t of targets) moveBy(t, dx, dy);
  fr.x = b.x + dx - m;
  fr.y = b.y + dy - m;
  s.w = Math.round((b.w + 2 * m) * 1000) / 1000;
  s.h = Math.round((b.h + 2 * m) * 1000) / 1000;
}

/** Rahmen nach Größenänderung ihres Ziels neu anpassen */
async function refitFrames() {
  for (const fr of items.filter(isFrame)) {
    fitFrame(fr);
    await rebuildShape(fr);
  }
}

function moveBy(it: Item, dx: number, dy: number) {
  it.x += dx;
  it.y += dy;
}

function removeItem(id: number) {
  if (busy) return;
  const it = items.find((o) => o.id === id);
  if (!it) return;
  items = items.filter((o) => o.id !== id);
  if (selectedId === id) selectedId = null;
  setOpsFromContent();
  if (!items.length) showWarnings([]);
  setStatus(`${it.name} entfernt.`);
  renderEditor();
  refreshAll();
}

function select(id: number | null) {
  if (selectedId === id) return;
  selectedId = id;
  renderEditor();
  renderList();
  updateInfo();
  draw();
}

// ------------------------------------------------------------------ Objektliste und Editor

function renderList() {
  const ul = $('itemList');
  ul.replaceChildren(
    ...items.map((it) => {
      const li = document.createElement('li');
      li.className = it.id === selectedId ? 'sel' : '';
      const sw = document.createElement('span');
      sw.className = 'sw ' + itemKind(it);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = it.name;
      name.title = it.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = `${fmt1(it.design.widthMm)} × ${fmt1(it.design.heightMm)}`;
      const del = document.createElement('button');
      del.className = 'x';
      del.textContent = '×';
      del.title = 'Entfernen (Entf)';
      del.disabled = busy;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeItem(it.id);
      });
      li.append(sw, name, size, del);
      li.addEventListener('click', () => select(it.id === selectedId ? null : it.id));
      return li;
    }),
  );
  ul.hidden = items.length === 0;
  $('itemsEmpty').hidden = items.length > 0;
}

function itemKind(it: Item): string {
  if (it.shape?.kind === 'test') return it.shape.mode === 'vector' ? 'engrave' : 'raster';
  if (it.shape && 'op' in it.shape) return it.shape.op === 'fill' ? 'raster' : it.shape.op;
  return 'file';
}

interface FieldSpec {
  label: string;
  unit?: string;
  type: 'num' | 'int' | 'select' | 'check';
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
  get: () => number | string | boolean;
  set: (v: number | string | boolean) => void;
}

const OPS_ALL: [string, string][] = [
  ['cut', 'Schneiden (rot)'],
  ['engrave', 'Gravieren (blau)'],
  ['fill', 'Füllen (Raster)'],
];

function specFor(sh: Shape): FieldSpec[] {
  const num = (label: string, unit: string, get: () => number, set: (v: number) => void, min = 0.1, step = 0.5): FieldSpec => ({
    label,
    unit,
    type: 'num',
    min,
    step,
    get,
    set: (v) => set(v as number),
  });
  const op = (opts = OPS_ALL): FieldSpec => ({
    label: 'Vorgang',
    type: 'select',
    options: opts,
    get: () => (sh as { op: string }).op,
    set: (v) => ((sh as { op: string }).op = v as string),
  });
  switch (sh.kind) {
    case 'rect':
      if (sh.frame) {
        const fr = sh.frame;
        return [num('Abstand', 'mm', () => fr.margin, (v) => (fr.margin = v), 0), num('Eckenradius', 'mm', () => sh.r, (v) => (sh.r = v), 0), op()];
      }
      return [num('Breite', 'mm', () => sh.w, (v) => (sh.w = v)), num('Höhe', 'mm', () => sh.h, (v) => (sh.h = v)), num('Eckenradius', 'mm', () => sh.r, (v) => (sh.r = v), 0), op()];
    case 'ellipse':
      return [num('Breite', 'mm', () => sh.w, (v) => (sh.w = v)), num('Höhe', 'mm', () => sh.h, (v) => (sh.h = v)), op()];
    case 'line':
      return [num('Länge', 'mm', () => sh.length, (v) => (sh.length = v)), { ...num('Winkel', '°', () => sh.angle, (v) => (sh.angle = v), -360, 15), min: -360, max: 360 }, op(OPS_ALL.slice(0, 2))];
    case 'polygon':
      return [
        { label: 'Ecken', type: 'int', min: 3, max: 100, step: 1, get: () => sh.n, set: (v) => (sh.n = v as number) },
        num('Durchmesser', 'mm', () => sh.d, (v) => (sh.d = v)),
        op(),
      ];
    case 'test':
      return [
        {
          label: 'Art',
          type: 'select',
          options: [
            ['raster', 'Gefüllte Felder (Raster)'],
            ['vector', 'Quadrat-Linien (Vektor)'],
          ],
          get: () => sh.mode,
          set: (v) => {
            if (v === sh.mode) return;
            sh.mode = v as 'raster' | 'vector';
            Object.assign(sh, TEST_SPEEDS[sh.mode]);
          },
        },
        { label: 'Anzahl Felder', type: 'int', min: 1, max: 20, step: 1, get: () => sh.count, set: (v) => (sh.count = v as number) },
        num('Geschw. von', 'mm/s', () => sh.vMin, (v) => (sh.vMin = v), 0.1, 1),
        num('Geschw. bis', 'mm/s', () => sh.vMax, (v) => (sh.vMax = v), 0.1, 1),
        num('Feldgröße', 'mm', () => sh.size, (v) => (sh.size = v), 1),
        num('Abstand', 'mm', () => sh.gap, (v) => (sh.gap = v), 0),
        { label: 'Beschriftung', type: 'check', get: () => sh.labels, set: (v) => (sh.labels = v as boolean) },
      ];
  }
}

function renderEditor() {
  const box = $('itemEditor');
  const it = selected();
  if (!it) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const kids: HTMLElement[] = [];
  const title = document.createElement('div');
  title.className = 'edtitle';
  title.textContent = it.name;
  kids.push(title);
  if (!it.shape) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = 'Datei – Größe und Inhalt im Zeichenprogramm ändern, dann „Neu laden“. Rot = schneiden, Blau = gravieren, Rest = Raster.';
    kids.push(h);
  } else {
    const grid = document.createElement('div');
    grid.className = 'settings';
    const sh = it.shape;
    for (const f of specFor(sh)) {
      const label = document.createElement('label');
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.type === 'select') {
        const s = document.createElement('select');
        for (const [v, t] of f.options!) s.add(new Option(t, v));
        s.value = String(f.get());
        input = s;
      } else {
        const i = document.createElement('input');
        if (f.type === 'check') {
          i.type = 'checkbox';
          i.checked = Boolean(f.get());
          label.className = 'check';
        } else {
          i.type = 'number';
          i.step = String(f.step ?? 0.5);
          if (f.min !== undefined) i.min = String(f.min);
          if (f.max !== undefined) i.max = String(f.max);
          i.value = String(f.get());
        }
        input = i;
      }
      input.addEventListener('change', () => void onFieldChange(it, f, input));
      if (f.type === 'check') {
        label.append(input, document.createTextNode(' ' + f.label));
      } else {
        label.append(document.createTextNode(f.label + (f.unit ? ` (${f.unit})` : '')), input);
      }
      grid.append(label);
    }
    kids.push(grid);
    if (sh.kind === 'test') {
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = `Jedes Feld läuft mit seiner eigenen Geschwindigkeit (Zahl darunter, mm/s); Durchgänge wie unter „Auftrag“ (${sh.mode === 'raster' ? 'Raster-Gravur' : 'Vektor-Gravur'}). Die Leistung stellst du am Poti ein.`;
      kids.push(h);
    } else if (sh.kind === 'rect' && sh.frame) {
      const h = document.createElement('div');
      h.className = 'hint';
      const t = frameTargets(it);
      h.textContent = `Rahmen um ${t.length === 1 ? `„${t[0].name}“` : 'alle Objekte'} – ${fmt1(sh.w)} × ${fmt1(sh.h)} mm. Verschiebt sich mit dem Objekt.`;
      kids.push(h);
    }
  }
  box.replaceChildren(...kids);
}

async function onFieldChange(it: Item, f: FieldSpec, input: HTMLInputElement | HTMLSelectElement) {
  if (busy) {
    renderEditor();
    return;
  }
  let v: number | string | boolean;
  if (f.type === 'select') v = input.value;
  else if (f.type === 'check') v = (input as HTMLInputElement).checked;
  else {
    let n = parseFloat(input.value.replace(',', '.'));
    if (!Number.isFinite(n)) {
      input.value = String(f.get());
      return;
    }
    if (f.type === 'int') n = Math.round(n);
    if (f.min !== undefined) n = Math.max(f.min, n);
    if (f.max !== undefined) n = Math.min(f.max, n);
    v = n;
  }
  f.set(v);
  if (isFrame(it)) fitFrame(it);
  if (await rebuildShape(it)) {
    clampItem(it);
    setOpsFromContent();
    renderEditor();
    refreshAll();
  }
}

// ------------------------------------------------------------------ Info / Knöpfe

function pathLength(polys: Polyline[]): number {
  let l = 0;
  for (const p of polys) for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

function content() {
  const v = composeVectors(items, 0, 0);
  let rasterItems = 0;
  let rasterFields = 0;
  let vectorFields = 0;
  for (const it of items) {
    if (it.design.hasRaster) rasterItems++;
    if (it.shape?.kind === 'test') {
      if (it.shape.mode === 'raster') rasterFields += it.fields?.length ?? 0;
      else vectorFields += it.fields?.length ?? 0;
    }
  }
  return { ...v, rasterItems, rasterFields, vectorFields };
}

function setOpsFromContent() {
  const c = content();
  $<HTMLInputElement>('opRaster').checked = c.rasterItems + c.rasterFields > 0;
  $<HTMLInputElement>('opEngrave').checked = c.engrave.length + c.vectorFields > 0;
  $<HTMLInputElement>('opCut').checked = c.cut.length > 0;
}

function updateInfo() {
  const has = items.length > 0;
  const c = content();
  const parts = (a: string[]) => a.filter(Boolean).join(' + ');
  $('infoRaster').textContent = !has
    ? '–'
    : parts([c.rasterItems ? (items.length > 1 ? `${c.rasterItems} Objekt(e) mit Rasterinhalt` : 'Rasterinhalt vorhanden') : '', c.rasterFields ? `${c.rasterFields} Testfelder` : '']) || 'kein Rasterinhalt';
  const vec = (polys: Polyline[], what: string, fields: number, color: string) =>
    !has ? '–' : parts([polys.length ? `${polys.length} ${what}, ${Math.round(pathLength(polys))} mm` : '', fields ? `${fields} Testfelder` : '']) || `keine (Kontur ${color})`;
  $('infoEngrave').textContent = vec(c.engrave, 'Pfade', c.vectorFields, 'blau');
  $('infoCut').textContent = vec(c.cut, 'Schnitte', 0, 'rot');
  const sim = currentSim();
  $('estimate').textContent = sim ? `Geschätzte Dauer: ${fmtTime(sim.seconds)}` : '';
  const sel = selected();
  const box = jobBox();
  const pos = sel ? `${sel.name}: X ${fmt1(sel.x)} / Y ${fmt1(sel.y)} mm` : box ? `Auftrag: X ${fmt1(box.x)} / Y ${fmt1(box.y)} mm` : 'Kein Objekt';
  $('posText').textContent = `${pos} · Kopf: ${homed || !laser ? `X ${fmtMm(head.x)} / Y ${fmtMm(head.y)} mm` : 'unbekannt (Home drücken)'}`;
  const tgt = sel ?? box;
  if (tgt) {
    for (const [id, v] of [
      ['gotoX', tgt.x],
      ['gotoY', tgt.y],
    ] as const) {
      const el = $<HTMLInputElement>(id);
      if (document.activeElement !== el) el.value = String(Math.round(v * 10) / 10);
    }
  }
  const files = items.filter((it) => it.file);
  const shapes = items.length - files.length;
  $('fileName').textContent = !has
    ? 'Keine Datei geladen – SVG oder Bild hierher ziehen oder links eine Form hinzufügen'
    : `${[files.map((f) => f.name).join(', '), shapes ? `${shapes} Form${shapes > 1 ? 'en' : ''}` : ''].filter(Boolean).join(' + ')} – Auftrag ${fmt1(box!.w)} × ${fmt1(box!.h)} mm`;
}

function updateButtons() {
  const has = items.length > 0;
  $<HTMLButtonElement>('btnStart').disabled = busy || !has;
  $<HTMLButtonElement>('btnExport').disabled = busy || !has;
  $<HTMLButtonElement>('btnReload').disabled = busy || !items.some((it) => it.file);
  $<HTMLButtonElement>('btnStop').disabled = !busy || !laser;
  for (const id of ['btnHome', 'btnUnlock', 'btnStatus']) $<HTMLButtonElement>(id).disabled = busy || !laser;
  document.querySelectorAll<HTMLButtonElement>('[data-jog],[data-corner],#btnGoto,#btnCenterHead,[data-add],#itemList button').forEach((b) => (b.disabled = busy));
  $('btnConnect').hidden = laser !== null;
  $('btnDisconnect').hidden = laser === null;
  const silent = laser !== null && responsive === false;
  $('connDot').className = 'dot' + (laser ? (busy ? ' busy' : silent ? ' stale' : ' on') : '');
  $('connText').textContent = laser ? (busy ? 'Verbunden – Auftrag läuft' : silent ? 'Verbunden – Laser antwortet nicht' : 'Verbunden') : K40Usb.isSupported() ? 'Nicht verbunden (Simulation)' : 'WebUSB nicht verfügbar – bitte Chrome/Edge verwenden';
  $<HTMLButtonElement>('btnConnect').disabled = !K40Usb.isSupported();
}

// ------------------------------------------------------------------ Position

function clampItem(it: Item) {
  it.x = Math.max(0, Math.min(it.x, S.bedW - it.design.widthMm));
  it.y = Math.max(0, Math.min(it.y, S.bedH - it.design.heightMm));
}

/** Freie Stelle für ein neues Objekt: rechts neben bzw. unter den vorhandenen, sonst oben links. */
function placeFree(it: Item) {
  const b = jobBox();
  const w = it.design.widthMm;
  const h = it.design.heightMm;
  const gap = 5;
  if (!b) {
    it.x = 0;
    it.y = 0;
  } else if (b.x + b.w + gap + w <= S.bedW) {
    it.x = b.x + b.w + gap;
    it.y = b.y;
  } else if (b.y + b.h + gap + h <= S.bedH) {
    it.x = b.x;
    it.y = b.y + b.h + gap;
  } else {
    it.x = 0;
    it.y = 0;
  }
  clampItem(it);
}

/** Objekte, die sich gemeinsam bewegen: Auswahl + ihre Rahmen, ohne Auswahl alle. */
function movers(): Item[] {
  const sel = selected();
  if (!sel) return items;
  const out = [sel];
  for (const o of items) if (o !== sel && isFrame(o) && (o.shape as RectShape).frame!.target === sel.id) out.push(o);
  return out;
}

/** Gruppe verschieben, ohne den Arbeitsbereich zu verlassen. */
function moveGroup(group: Item[], start: { x: number; y: number }[], dx: number, dy: number) {
  const b = unionBox(group.map((it, i) => ({ ...it, x: start[i].x, y: start[i].y })));
  if (!b) return;
  const cx = (d: number, lo: number, hi: number) => Math.min(Math.max(d, lo), Math.max(lo, hi));
  dx = cx(dx, -b.x, S.bedW - b.x - b.w);
  dy = cx(dy, -b.y, S.bedH - b.y - b.h);
  group.forEach((it, i) => {
    it.x = start[i].x + dx;
    it.y = start[i].y + dy;
  });
}

/** Wohin der Kopf nach dem Verschieben fährt: Ecke der Auswahl bzw. Startpunkt des Auftrags. */
function headTarget(): { x: number; y: number } | null {
  const t = selected() ?? jobBox();
  return t ? { x: t.x * MIL_PER_MM, y: t.y * MIL_PER_MM } : null;
}

/** Kopf an Position fahren (Eilgang). Bewegungen werden nacheinander ausgeführt. */
function moveHeadTo(x: number, y: number): Promise<unknown> {
  motion = motion.then(async () => {
    const tx = Math.round(x);
    const ty = Math.round(y);
    const dx = tx - head.x;
    const dy = ty - head.y;
    if (dx === 0 && dy === 0) return;
    if (laser) {
      const w = new EgvWriter();
      w.makeMoveData(Math.round(dx * S.scaleX), -Math.round(dy * S.scaleY));
      try {
        await laser.sendData(w.out);
      } catch (e) {
        setStatus(`Bewegung fehlgeschlagen: ${(e as Error).message}`, 'error');
        throw e;
      }
    }
    head.x = tx;
    head.y = ty;
    updateInfo();
    draw();
  });
  motion = motion.catch(() => undefined);
  return motion;
}

function afterMove() {
  const t = headTarget();
  if (t) void moveHeadTo(t.x, t.y);
  refreshAll();
}

function jog(dxDir: number, dyDir: number) {
  if (busy || !items.length) return;
  const g = movers();
  moveGroup(
    g,
    g.map((it) => ({ x: it.x, y: it.y })),
    dxDir * S.jogStep,
    dyDir * S.jogStep,
  );
  afterMove();
}

function moveToCorner(c: string) {
  if (busy) return;
  const b = jobBox();
  if (!b) return;
  const off = { tl: [0, 0], tr: [b.w, 0], bl: [0, b.h], br: [b.w, b.h], c: [b.w / 2, b.h / 2] }[c] ?? [0, 0];
  void moveHeadTo((b.x + off[0]) * MIL_PER_MM, (b.y + off[1]) * MIL_PER_MM);
}

// ------------------------------------------------------------------ Laser

async function connect() {
  try {
    const k = await K40Usb.request();
    await attach(k, true);
  } catch (e) {
    if ((e as Error).name === 'NotFoundError') return setStatus('Kein Gerät ausgewählt.');
    setStatus(`Verbindung fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
}

async function attach(k: K40Usb, doHome: boolean) {
  laser = k;
  laser.timeoutMs = S.timeoutMs;
  const st = await laser.status().catch(() => null);
  responsive = st !== null;
  if (st === null) setStatus('Laser verbunden, antwortet aber nicht. Ist er eingeschaltet?', 'warn');
  else setStatus('Laser verbunden.');
  if (doHome) await home();
  updateButtons();
  updateInfo();
}

async function disconnect() {
  if (!laser || busy) return;
  await laser.close();
  laser = null;
  homed = false;
  responsive = null;
  updateButtons();
  updateInfo();
  setStatus('Laser getrennt.');
}

async function home() {
  if (!laser) return;
  await laser.home();
  head.x = head.y = 0;
  homed = true;
  updateInfo();
  draw();
  setStatus('Kopf fährt in die Ausgangsposition (oben links).');
}

async function unlock() {
  if (!laser) return;
  await laser.unlockRail();
  homed = false;
  updateInfo();
  setStatus('Achsen entriegelt – der Kopf kann von Hand verschoben werden. Danach „Home“ drücken.', 'warn');
}

async function queryStatus() {
  if (!laser) return;
  const r = await laser.status().catch(() => null);
  responsive = r !== null;
  updateButtons();
  const names: Record<number, string> = {
    [STATUS.OK]: 'OK',
    [STATUS.BUFFER_FULL]: 'Puffer voll',
    [STATUS.CRC_ERROR]: 'CRC-Fehler',
    [STATUS.TASK_COMPLETE]: 'Auftrag fertig',
    [STATUS.TASK_COMPLETE_M3]: 'Auftrag fertig',
    [STATUS.UNKNOWN_2]: 'bereit (nach Neuinitialisierung)',
  };
  setStatus(r === null ? 'Keine Antwort vom Laser.' : `Laser-Status: ${names[r] ?? 'unbekannt'} (${r})`, r === null ? 'warn' : '');
}

async function pollStatus() {
  if (!laser || busy || polling || drag || document.hidden) return;
  polling = true;
  const k = laser;
  try {
    const r = await k.status().catch(() => null);
    if (laser !== k || busy) return; // inzwischen getrennt oder Auftrag gestartet
    const now = r !== null;
    if (now !== responsive) {
      const before = responsive;
      responsive = now;
      updateButtons();
      if (!now) setStatus('Laser antwortet nicht mehr – ist er eingeschaltet?', 'warn');
      else if (before === false) setStatus('Laser antwortet wieder.');
    }
  } finally {
    polling = false;
  }
}

// ------------------------------------------------------------------ Auftrag

function currentOps(): JobOps {
  return {
    raster: $<HTMLInputElement>('opRaster').checked,
    engrave: $<HTMLInputElement>('opEngrave').checked,
    cut: $<HTMLInputElement>('opCut').checked,
  };
}

async function getRasterBits(ox: number, oy: number, onProgress: (f: number) => void): Promise<RasterBits | null> {
  const comp = composeRaster(items, ox, oy, S);
  if (!comp) return null;
  const gkey = `${comp.key}|${S.rasterStepMils}|${S.scaleX}|${S.scaleY}`;
  if (!grayCache || grayCache.key !== gkey) {
    const gray = await renderRaster(comp.design, S.rasterStepMils, S.scaleX, S.scaleY, onProgress);
    grayCache = { key: gkey, gray };
    bitsCache = null;
  }
  const bkey = `${gkey}|${S.rasterMode}|${S.threshold}|${S.gamma}|${S.invert}`;
  if (!bitsCache || bitsCache.key !== bkey) {
    bitsCache = { key: bkey, bits: grayToBits(grayCache.gray, { mode: S.rasterMode, threshold: S.threshold, invert: S.invert, gamma: S.gamma }) };
  }
  return { ...bitsCache.bits, offsetX: comp.offsetX, offsetY: comp.offsetY };
}

async function makeJobData(ops: JobOps): Promise<number[]> {
  const box = jobBox();
  if (!box) throw new Error('Keine Datei geladen.');
  if (!ops.raster && !ops.engrave && !ops.cut) throw new Error('Bitte mindestens einen Vorgang auswählen.');
  let raster: RasterBits | null = null;
  if (ops.raster) {
    raster = await getRasterBits(box.x, box.y, (f) => {
      setStatus(`Raster wird berechnet: ${Math.round(f * 100)} %`, 'busy');
      setProgress(f);
    });
  }
  const { cut, engrave } = composeVectors(items, box.x, box.y);
  const extra = composeExtras(items, box.x, box.y, S);
  return buildJob({ cut, engrave, raster, extra }, ops, S);
}

async function startJob() {
  const box = jobBox();
  if (!box || busy) return;
  const ops = currentOps();
  busy = true;
  abortRequested = false;
  updateButtons();
  setProgress(0);
  try {
    setStatus('Bereite Auftrag vor …', 'busy');
    const data = await makeJobData(ops);
    const sim = simulateEgv(data, S.board);
    simCache = { key: simKey(ops), sim };
    updateInfo();
    draw();
    if (!laser) {
      setStatus(`Kein Laser verbunden – nur simuliert. Geschätzte Dauer ${fmtTime(sim.seconds)}. Aktiviere „Pfad-Simulation“ für die Vorschau.`, 'warn');
      return;
    }
    await moveHeadTo(box.x * MIL_PER_MM, box.y * MIL_PER_MM);
    const t0 = performance.now();
    await laser.sendData(data, {
      shouldAbort: () => abortRequested,
      onProgress: (f, msg) => {
        setProgress(f);
        setStatus(msg, 'busy');
      },
      onWarning: (m) => setStatus(m, 'warn'),
      waitForLaser: S.waitFinish,
    });
    const secs = (performance.now() - t0) / 1000;
    setStatus(`Auftrag abgeschlossen (${fmtTime(secs)}).`);
    notifyDone();
  } catch (e) {
    if (e instanceof AbortedError) {
      homed = false;
      setStatus('Auftrag abgebrochen (Not-Halt gesendet). Bitte „Home“ drücken, bevor du weiterarbeitest.', 'error');
    } else {
      setStatus(`Fehler: ${(e as Error).message}`, 'error');
    }
  } finally {
    busy = false;
    paused = false;
    setProgress(null);
    renderList();
    updateButtons();
    updateInfo();
  }
}

function notifyDone() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch {
    /* kein Ton */
  }
}

async function stopJob() {
  if (!busy || !laser) return;
  if (!paused) {
    paused = true;
    await laser.togglePause().catch(() => undefined);
  }
  const dlg = $<HTMLDialogElement>('dlg');
  $('dlgText').textContent = 'Der Laser ist pausiert. Auftrag abbrechen oder fortsetzen?';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    async () => {
      if (dlg.returnValue === 'ok') {
        abortRequested = true;
        setStatus('Breche ab …', 'error');
      } else {
        paused = false;
        await laser?.togglePause().catch(() => undefined);
        setStatus('Fortgesetzt.', 'busy');
      }
    },
    { once: true },
  );
}

async function exportEgv() {
  if (!items.length || busy) return;
  busy = true;
  updateButtons();
  try {
    const data = await makeJobData(currentOps());
    const blob = new Blob([egvFileContent(data)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const first = items.find((it) => it.file);
    a.download = (first ? first.name.replace(/\.[^.]+$/, '') : 'k40-auftrag') + '.EGV';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus(`EGV-Datei gespeichert (${data.length} Byte).`);
  } catch (e) {
    setStatus(`Export fehlgeschlagen: ${(e as Error).message}`, 'error');
  } finally {
    busy = false;
    setProgress(null);
    updateButtons();
  }
}

function simKey(ops: JobOps) {
  const b = jobBox();
  // Lage relativ zum Auftragsursprung – Verschieben des ganzen Auftrags ändert die Simulation nicht
  return JSON.stringify([items.map((it) => [it.id, it.version, b ? +(it.x - b.x).toFixed(4) : 0, b ? +(it.y - b.y).toFixed(4) : 0]), ops, S]);
}

/** Simulation nur zeigen, wenn sie zum aktuellen Stand passt. */
function currentSim(): SimResult | null {
  return simCache && simCache.key === simKey(currentOps()) ? simCache.sim : null;
}

async function refreshSim() {
  if (!items.length || !S.showSim) return draw();
  const ops = currentOps();
  const key = simKey(ops);
  if (simCache?.key === key) return draw();
  if (busy || drag) return;
  try {
    if (!ops.raster && !ops.engrave && !ops.cut) {
      simCache = null;
    } else {
      const data = await makeJobData(ops);
      if (simKey(ops) !== key) return; // inzwischen geändert
      simCache = { key, sim: simulateEgv(data, S.board) };
      setStatus(`Simulation: geschätzte Dauer ${fmtTime(simCache.sim.seconds)}.`);
    }
  } catch (e) {
    setStatus(`Simulation fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
  setProgress(null);
  updateInfo();
  draw();
}

// ------------------------------------------------------------------ Zeichnen

let view = { k: 1, ox: 0, oy: 0 };

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const m = 34;
  const k = Math.min((rect.width - 2 * m) / S.bedW, (rect.height - 2 * m) / S.bedH);
  view = { k, ox: (rect.width - S.bedW * k) / 2, oy: (rect.height - S.bedH * k) / 2 };
  const X = (mm: number) => view.ox + mm * k;
  const Y = (mm: number) => view.oy + mm * k;

  // Arbeitsbereich + Raster
  ctx.fillStyle = css('--bed');
  ctx.fillRect(X(0), Y(0), S.bedW * k, S.bedH * k);
  ctx.lineWidth = 1;
  for (let x = 0; x <= S.bedW; x += 10) {
    ctx.strokeStyle = x % 50 === 0 ? css('--grid-major') : css('--grid');
    ctx.beginPath();
    ctx.moveTo(Math.round(X(x)) + 0.5, Y(0));
    ctx.lineTo(Math.round(X(x)) + 0.5, Y(S.bedH));
    ctx.stroke();
  }
  for (let y = 0; y <= S.bedH; y += 10) {
    ctx.strokeStyle = y % 50 === 0 ? css('--grid-major') : css('--grid');
    ctx.beginPath();
    ctx.moveTo(X(0), Math.round(Y(y)) + 0.5);
    ctx.lineTo(X(S.bedW), Math.round(Y(y)) + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = css('--grid-major');
  ctx.strokeRect(X(0) + 0.5, Y(0) + 0.5, S.bedW * k, S.bedH * k);
  ctx.fillStyle = css('--muted');
  ctx.font = '10px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let x = 0; x <= S.bedW; x += 50) ctx.fillText(String(x), X(x), Y(0) - 6);
  ctx.textAlign = 'right';
  for (let y = 50; y <= S.bedH; y += 50) ctx.fillText(String(y), X(0) - 5, Y(y) + 3);

  // Objekte
  const sim = S.showSim ? currentSim() : null;
  const box = jobBox();
  if (!sim) {
    for (const it of items) {
      const d = it.design;
      if (d.preview) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(d.preview, X(it.x), Y(it.y), d.widthMm * k, d.heightMm * k);
        ctx.globalAlpha = 1;
      }
      const drawPolys = (polys: Polyline[], color: string) => {
        if (!polys.length) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const p of polys) {
          ctx.moveTo(X(it.x + p[0][0]), Y(it.y + p[0][1]));
          for (let i = 1; i < p.length; i++) ctx.lineTo(X(it.x + p[i][0]), Y(it.y + p[i][1]));
        }
        ctx.stroke();
      };
      drawPolys(d.engrave, '#2563eb');
      drawPolys(d.cut, '#e11d48');
    }
  } else if (box) {
    drawSim(ctx, sim, X, Y, box);
  }
  for (const it of items) {
    const sel = it.id === selectedId;
    ctx.setLineDash(sel ? [6, 3] : [4, 4]);
    ctx.strokeStyle = sel ? css('--accent') : css('--muted');
    ctx.lineWidth = sel ? 1.5 : 1;
    const pad = sel ? 2 : 0;
    ctx.strokeRect(X(it.x) - pad, Y(it.y) - pad, it.design.widthMm * k + 2 * pad, it.design.heightMm * k + 2 * pad);
  }
  ctx.setLineDash([]);
  // Startpunkt des Auftrags
  if (box && items.length > 1) {
    ctx.fillStyle = css('--go');
    ctx.beginPath();
    ctx.moveTo(X(box.x), Y(box.y));
    ctx.lineTo(X(box.x) + 9, Y(box.y));
    ctx.lineTo(X(box.x), Y(box.y) + 9);
    ctx.closePath();
    ctx.fill();
  }

  // Laserkopf
  const hx = X(head.x / MIL_PER_MM);
  const hy = Y(head.y / MIL_PER_MM);
  ctx.strokeStyle = homed || !laser ? '#16a34a' : '#f59e0b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(hx, hy, 6, 0, Math.PI * 2);
  ctx.moveTo(hx - 11, hy);
  ctx.lineTo(hx + 11, hy);
  ctx.moveTo(hx, hy - 11);
  ctx.lineTo(hx, hy + 11);
  ctx.stroke();
}

let simLayer: { sim: SimResult; w: number; h: number; canvas: HTMLCanvasElement; vectors: SimResult['segments'] } | null = null;

/** Brennwege in ein Bitmap rastern – Rasteraufträge haben leicht Millionen Segmente. */
function buildSimLayer(sim: SimResult, box: Box, k: number, dpr: number) {
  const w = Math.max(1, Math.ceil((box.w + 4) * k * dpr));
  const h = Math.max(1, Math.ceil((box.h + 4) * k * dpr));
  if (simLayer && simLayer.sim === sim && simLayer.w === w && simLayer.h === h) return simLayer;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  const color = 0xff1673f9; // ABGR: #f97316
  const f = (k * dpr) / MIL_PER_MM;
  const off = 2 * k * dpr; // 2 mm Rand
  const vectors: SimResult['segments'] = [];
  for (const s of sim.segments) {
    if (!s.laser) continue;
    if (s.y0 !== s.y1) {
      vectors.push(s);
      continue;
    }
    const row = Math.floor(off + (-s.y0 / S.scaleY) * f);
    if (row < 0 || row >= h) continue;
    let a = Math.floor(off + (Math.min(s.x0, s.x1) / S.scaleX) * f);
    let b = Math.ceil(off + (Math.max(s.x0, s.x1) / S.scaleX) * f);
    a = Math.max(0, a);
    b = Math.min(w, Math.max(b, a + 1));
    px.fill(color, row * w + a, row * w + b);
  }
  ctx.putImageData(img, 0, 0);
  simLayer = { sim, w, h, canvas: c, vectors };
  return simLayer;
}

function drawSim(ctx: CanvasRenderingContext2D, sim: SimResult, X: (mm: number) => number, Y: (mm: number) => number, box: Box) {
  const dpr = window.devicePixelRatio || 1;
  const ax = box.x;
  const ay = box.y;
  const toX = (mils: number) => X(ax + mils / S.scaleX / MIL_PER_MM);
  const toY = (mils: number) => Y(ay - mils / S.scaleY / MIL_PER_MM);
  const rapids = sim.segments.filter((s) => !s.laser && s.rapid);
  if (rapids.length < 20000) {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(120,130,145,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const s of rapids) {
      ctx.moveTo(toX(s.x0), toY(s.y0));
      ctx.lineTo(toX(s.x1), toY(s.y1));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const layer = buildSimLayer(sim, box, view.k, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer.canvas, X(ax - 2), Y(ay - 2), layer.w / dpr, layer.h / dpr);
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = Math.max(1, view.k * 0.06);
  ctx.beginPath();
  for (const s of layer.vectors) {
    ctx.moveTo(toX(s.x0), toY(s.y0));
    ctx.lineTo(toX(s.x1), toY(s.y1));
  }
  ctx.stroke();
}

// Objekte mit der Maus auswählen und verschieben
let drag: { sx: number; sy: number; group: Item[]; start: { x: number; y: number }[]; moved: boolean } | null = null;

function hitTest(e: PointerEvent): Item | null {
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left - view.ox) / view.k;
  const my = (e.clientY - r.top - view.oy) / view.k;
  const tol = Math.max(1, 6 / view.k);
  const inside = (it: Item) => {
    const b = itemBox(it);
    return mx >= b.x - tol && mx <= b.x + b.w + tol && my >= b.y - tol && my <= b.y + b.h + tol;
  };
  // Kleine Objekte vor großen (z.B. Inhalt vor seinem Rahmen), sonst oberstes zuerst
  const hits = items.filter(inside);
  if (!hits.length) return null;
  const area = (it: Item) => it.design.widthMm * it.design.heightMm;
  return hits.reduce((a, b) => (area(b) <= area(a) ? b : a));
}

canvas.addEventListener('pointerdown', (e) => {
  if (busy) return;
  const hit = hitTest(e);
  select(hit?.id ?? null);
  if (!hit) return;
  const group = movers();
  drag = { sx: e.clientX, sy: e.clientY, group, start: group.map((it) => ({ x: it.x, y: it.y })), moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    canvas.style.cursor = !busy && hitTest(e) ? 'grab' : 'default';
    return;
  }
  canvas.style.cursor = 'grabbing';
  const dx = (e.clientX - drag.sx) / view.k;
  const dy = (e.clientY - drag.sy) / view.k;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
  drag.moved = true;
  moveGroup(drag.group, drag.start, dx, dy);
  updateInfo();
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  canvas.style.cursor = 'grab';
  if (moved) afterMove();
});

// ------------------------------------------------------------------ Verdrahtung

function init() {
  bindSettings();
  $('fileInput').addEventListener('change', (e) => {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    void openFiles(files, true);
    (e.target as HTMLInputElement).value = '';
  });
  $('fileAdd').addEventListener('change', (e) => {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    void openFiles(files, false);
    (e.target as HTMLInputElement).value = '';
  });
  $('btnReload').addEventListener('click', () => void reloadFiles());
  $('btnConnect').addEventListener('click', () => void connect());
  $('btnDisconnect').addEventListener('click', () => void disconnect());
  $('btnHome').addEventListener('click', () => void home());
  $('btnUnlock').addEventListener('click', () => void unlock());
  $('btnStatus').addEventListener('click', () => void queryStatus());
  $('btnStart').addEventListener('click', () => void startJob());
  $('btnStop').addEventListener('click', () => void stopJob());
  $('btnExport').addEventListener('click', () => void exportEgv());
  $('btnCenterHead').addEventListener('click', () => {
    const b = jobBox();
    if (!busy && b) void moveHeadTo(b.x * MIL_PER_MM, b.y * MIL_PER_MM);
  });
  $('btnGoto').addEventListener('click', () => {
    if (busy || !items.length) return;
    const tx = parseFloat($<HTMLInputElement>('gotoX').value.replace(',', '.')) || 0;
    const ty = parseFloat($<HTMLInputElement>('gotoY').value.replace(',', '.')) || 0;
    const g = movers();
    const b = unionBox(selected() ? [selected()!] : g)!;
    moveGroup(
      g,
      g.map((it) => ({ x: it.x, y: it.y })),
      tx - b.x,
      ty - b.y,
    );
    afterMove();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-jog]').forEach((b) =>
    b.addEventListener('click', () => {
      const [dx, dy] = b.dataset.jog!.split(',').map(Number);
      jog(dx, dy);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-corner]').forEach((b) => b.addEventListener('click', () => moveToCorner(b.dataset.corner!)));
  document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      const kind = b.dataset.add!;
      if (kind === 'frame') void addFrame();
      else void addShape(kind as Shape['kind']);
    }),
  );
  for (const id of ['opRaster', 'opEngrave', 'opCut']) $(id).addEventListener('change', () => refreshAll());
  $('showSim').addEventListener('change', () => void refreshSim());

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('input,select,textarea,dialog')) return;
    const map: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (map[e.key]) {
      e.preventDefault();
      jog(...map[e.key]);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null) {
      e.preventDefault();
      removeItem(selectedId);
    } else if (e.key === 'Escape') {
      select(null);
    }
  });

  // Drag & Drop: erste Datei ersetzt die bisherige, weitere werden hinzugefügt
  stage.addEventListener('dragover', (e) => {
    e.preventDefault();
    stage.classList.add('dragover');
  });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void openFiles(files, true);
  });

  new ResizeObserver(() => draw()).observe(stage);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());

  if (K40Usb.isSupported()) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (laser && (e as USBConnectionEvent).device === laser.device) {
        laser = null;
        homed = false;
        responsive = null;
        abortRequested = true;
        updateButtons();
        updateInfo();
        setStatus('Laser wurde getrennt (USB).', 'warn');
      }
    });
    // Wieder eingesteckt / eingeschaltet: automatisch verbinden (nur bereits freigegebene Geräte)
    navigator.usb.addEventListener('connect', (e) => {
      const device = (e as USBConnectionEvent).device;
      if (laser || autoConnecting || !K40Usb.matches(device)) return;
      autoConnecting = true;
      K40Usb.fromDevice(device)
        .then((k) => attach(k, false))
        .then(() => {
          if (responsive) setStatus('Laser wieder verbunden. Bitte „Home“ drücken, damit die Position bekannt ist.', 'warn');
        })
        .catch((err) => setStatus(`Automatisches Verbinden fehlgeschlagen: ${(err as Error).message}`, 'error'))
        .finally(() => (autoConnecting = false));
    });
    // Im Leerlauf regelmäßig prüfen, ob der Controller noch antwortet
    setInterval(() => void pollStatus(), 3000);
    // bereits freigegebenes Gerät automatisch verbinden (ohne Fahrbewegung)
    K40Usb.reconnect()
      .then((k) => k && attach(k, false).then(() => setStatus('Laser verbunden. Bitte „Home“ drücken, damit die Position bekannt ist.')))
      .catch(() => undefined);
  } else {
    setStatus('Dieser Browser unterstützt kein WebUSB. Bitte Google Chrome oder Microsoft Edge verwenden.', 'warn');
  }

  renderEditor();
  refreshAll();
}

init();
