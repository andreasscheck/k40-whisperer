/**
 * Aufbereitung eines Designs zu einem Laserauftrag:
 *  - Linienzüge (mm, Ursprung oben links, y nach unten) -> ECoords (Zoll, y nach oben)
 *  - Schneidreihenfolge optimieren ("innen zuerst", kurze Leerfahrten) – wie K40 Whisperer
 *  - Rasterbild -> Scanlinien
 *  - EGV-Daten erzeugen und zu einem Auftrag zusammenfügen
 */
import { EgvWriter, joinJobParts, stripRedundantCodes, type ECoord } from './egv';
import type { BoardName } from './laserSpeed';
import type { Polyline } from './pathFlatten';

export const MM_PER_IN = 25.4;

export interface JobSettings {
  board: BoardName;
  /** Zeilenabstand Raster in 1/1000 Zoll (2 = 0,05 mm) */
  rasterStepMils: number;
  rasterBottomUp: boolean;
  rasterFeed: number;
  rasterPasses: number;
  engraveFeed: number;
  engravePasses: number;
  cutFeed: number;
  cutPasses: number;
  insideFirst: boolean;
  scaleX: number;
  scaleY: number;
}

export const DEFAULT_JOB: JobSettings = {
  board: 'M2',
  rasterStepMils: 2,
  rasterBottomUp: false,
  rasterFeed: 100,
  rasterPasses: 1,
  engraveFeed: 20,
  engravePasses: 1,
  cutFeed: 10,
  cutPasses: 1,
  insideFirst: true,
  scaleX: 1,
  scaleY: 1,
};

/** Rasterdaten: eine Zeile pro Scanlinie, 1 Pixel = 1/1000 Zoll; 1 = brennen */
export interface RasterBits {
  width: number;
  rows: number;
  stepMils: number;
  bits: Uint8Array;
  /** Lage der linken oberen Ecke relativ zum Auftragsursprung (1/1000 Zoll, y nach unten) */
  offsetX?: number;
  offsetY?: number;
}

// ---------------------------------------------------------------------------------- Vektoren

export function polylinesToEcoords(polys: Polyline[], scaleX = 1, scaleY = 1): ECoord[] {
  const out: ECoord[] = [];
  let loop = 0;
  for (const pl of polys) {
    if (pl.length < 2) continue;
    loop++;
    let last: [number, number] | null = null;
    let count = 0;
    const start = out.length;
    for (const [xm, ym] of pl) {
      const x = (xm / MM_PER_IN) * scaleX;
      const y = (-ym / MM_PER_IN) * scaleY;
      if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) continue;
      out.push([x, y, loop]);
      last = [x, y];
      count++;
    }
    if (count < 2) out.length = start;
  }
  return out;
}

/** Reihenfolge nach kürzester Leerfahrt (inkl. Umkehrung von Linienzügen). Portiert aus Sort_Paths. */
function sortPaths(ec: ECoord[]): [number, number][] {
  const Lbeg: number[] = [];
  const Lend: number[] = [];
  if (ec.length === 0) return [];
  Lbeg.push(0);
  let loopOld = ec[0][2];
  let i = 1;
  for (; i < ec.length; i++) {
    if (ec[i][2] !== loopOld) {
      Lbeg.push(i);
      Lend.push(i - 1);
    }
    loopOld = ec[i][2];
  }
  Lend.push(ec.length - 1);

  const order: [number, number][] = [[Lbeg[0], Lend[0]]];
  let useBeg = 0;
  let inext = 0;
  const total = Lbeg.length;
  for (let k = 0; k < total - 1; k++) {
    let ii: number;
    if (useBeg === 1) {
      ii = Lbeg.splice(inext, 1)[0];
      Lend.splice(inext, 1);
    } else {
      ii = Lend.splice(inext, 1)[0];
      Lbeg.splice(inext, 1);
    }
    const xc = ec[ii][0];
    const yc = ec[ii][1];
    let minDist = Infinity;
    let minDistE = Infinity;
    let inextB = 0;
    let inextE = 0;
    for (let j = 0; j < Lbeg.length; j++) {
      const db = (xc - ec[Lbeg[j]][0]) ** 2 + (yc - ec[Lbeg[j]][1]) ** 2;
      if (db < minDist) {
        minDist = db;
        inextB = j;
      }
      const de = (xc - ec[Lend[j]][0]) ** 2 + (yc - ec[Lend[j]][1]) ** 2;
      if (de < minDistE) {
        minDistE = de;
        inextE = j;
      }
    }
    if (minDistE < minDist) {
      inext = inextE;
      order.push([Lend[inext], Lbeg[inext]]);
      useBeg = 1;
    } else {
      inext = inextB;
      order.push([Lbeg[inext], Lend[inext]]);
      useBeg = 0;
    }
  }
  return order;
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  const n = poly.length;
  let [p1x, p1y] = poly[0];
  for (let i = 1; i <= n; i++) {
    const [p2x, p2y] = poly[i % n];
    if (y > Math.min(p1y, p2y) && y <= Math.max(p1y, p2y) && x <= Math.max(p1x, p2x)) {
      let xinters = -Infinity;
      if (p1y !== p2y) xinters = ((y - p1y) * (p2x - p1x)) / (p2y - p1y) + p1x;
      if (p1x === p2x || x <= xinters) inside = !inside;
    }
    p1x = p2x;
    p1y = p2y;
  }
  return inside;
}

/** Kurze Leerfahrten + (optional) innen liegende Konturen vor den äußeren schneiden. */
export function optimizePaths(ec: ECoord[], insideCheck: boolean): ECoord[] {
  const order = sortPaths(ec);
  const Acc = 0.004;
  const cuts: [number, number][][] = [];
  let lastx = -999;
  let lasty = -999;
  for (const [a, b] of order) {
    const step = a > b ? -1 : 1;
    let loopOld = -1;
    for (let i = a; i !== b + step; i += step) {
      const [x1, y1, loop] = ec[i];
      if (loop !== loopOld) {
        const dist = Math.hypot(x1 - lastx, y1 - lasty);
        if (dist > Acc || cuts.length === 0) cuts.push([[x1, y1]]);
        else cuts[cuts.length - 1].push([x1, y1]);
      } else {
        cuts[cuts.length - 1].push([x1, y1]);
      }
      lastx = x1;
      lasty = y1;
      loopOld = loop;
    }
  }
  let sequence = cuts.map((_, i) => i);
  if (insideCheck) {
    const inside: number[][] = cuts.map(() => []);
    for (let i = 0; i < cuts.length; i++) {
      if (cuts[i].length < 3) continue;
      for (let j = 0; j < cuts.length; j++) {
        if (i !== j && pointInPolygon(cuts[j][0][0], cuts[j][0][1], cuts[i])) inside[i].push(j);
      }
    }
    const done = new Uint8Array(cuts.length);
    const result: number[] = [];
    const visit = (i: number) => {
      if (done[i]) return;
      done[i] = 1;
      for (const j of inside[i]) visit(j);
      result.push(i);
    };
    for (let i = 0; i < cuts.length; i++) visit(i);
    sequence = result;
  }
  const out: ECoord[] = [];
  for (const i of sequence) for (const [x, y] of cuts[i]) out.push([x, y, i]);
  return out;
}

// ---------------------------------------------------------------------------------- Raster

/** Scanlinien wie make_raster_coords: oberste Zeile zuerst, pro dunklem Abschnitt ein Paar. */
export function rasterToEcoords(r: RasterBits): ECoord[] {
  const out: ECoord[] = [];
  let loop = 0;
  const ox = r.offsetX ?? 0;
  const oy = r.offsetY ?? 0;
  for (let row = 0; row < r.rows; row++) {
    const y = -(row * r.stepMils + oy) / 1000;
    const base = row * r.width;
    let x = 0;
    while (x < r.width) {
      if (!r.bits[base + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < r.width && r.bits[base + e]) e++;
      loop++;
      out.push([(x + ox) / 1000, y, loop], [(e + ox) / 1000, y, loop]);
      x = e;
    }
  }
  return out;
}

export interface GrayRaster {
  width: number;
  rows: number;
  stepMils: number;
  gray: Uint8Array; // 0 = schwarz, 255 = weiß
}

export interface RasterProcess {
  mode: 'threshold' | 'dither';
  threshold: number; // 0..255
  invert: boolean;
  /** Gamma > 1 = heller, < 1 = dunkler (nur Dithering) */
  gamma: number;
}

export function grayToBits(g: GrayRaster, p: RasterProcess): RasterBits {
  const { width, rows } = g;
  const bits = new Uint8Array(width * rows);
  if (p.mode === 'threshold') {
    for (let i = 0; i < bits.length; i++) {
      const v = p.invert ? 255 - g.gray[i] : g.gray[i];
      bits[i] = v < p.threshold ? 1 : 0;
    }
    return { width, rows, stepMils: g.stepMils, bits };
  }
  // Floyd-Steinberg auf quadratischen Zellen (Zellbreite = Zeilenabstand)
  const cell = Math.max(1, Math.round(g.stepMils));
  const cw = Math.ceil(width / cell);
  const buf = new Float32Array(cw * rows);
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, 1 / Math.max(0.05, p.gamma));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cw; c++) {
      let sum = 0;
      let n = 0;
      const x0 = c * cell;
      const x1 = Math.min(width, x0 + cell);
      for (let x = x0; x < x1; x++) {
        const v = g.gray[r * width + x];
        sum += p.invert ? 255 - v : v;
        n++;
      }
      buf[r * cw + c] = lut[Math.round(sum / n)];
    }
  }
  for (let r = 0; r < rows; r++) {
    const ltr = r % 2 === 0; // Serpentinen-Scan gegen Muster
    for (let k = 0; k < cw; k++) {
      const c = ltr ? k : cw - 1 - k;
      const i = r * cw + c;
      const old = buf[i];
      const nv = old < 128 ? 0 : 255;
      const err = old - nv;
      buf[i] = nv;
      const dir = ltr ? 1 : -1;
      if (c + dir >= 0 && c + dir < cw) buf[i + dir] += (err * 7) / 16;
      if (r + 1 < rows) {
        if (c - dir >= 0 && c - dir < cw) buf[i + cw - dir] += (err * 3) / 16;
        buf[i + cw] += (err * 5) / 16;
        if (c + dir >= 0 && c + dir < cw) buf[i + cw + dir] += (err * 1) / 16;
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) bits[r * width + x] = buf[r * cw + Math.floor(x / cell)] === 0 ? 1 : 0;
  }
  return { width, rows, stepMils: g.stepMils, bits };
}

// ---------------------------------------------------------------------------------- Auftrag

/** Zusatzteile mit eigener Geschwindigkeit (z.B. Testmuster) */
export type ExtraPart = { op: 'raster'; bits: RasterBits; feed: number } | { op: 'engrave' | 'cut'; polys: Polyline[]; feed: number };

export interface JobInput {
  cut?: Polyline[];
  engrave?: Polyline[];
  raster?: RasterBits | null;
  extra?: ExtraPart[];
}

export interface JobOps {
  raster: boolean;
  engrave: boolean;
  cut: boolean;
}

/**
 * Erzeugt den kompletten EGV-Datenstrom. Der Laserkopf muss vor dem Start an der oberen
 * linken Ecke des Designs stehen und kehrt am Ende dorthin zurück.
 */
export function buildJob(input: JobInput, ops: JobOps, s: JobSettings): number[] {
  const parts: { data: number[]; passes: number }[] = [];
  const extra = input.extra ?? [];
  const rasterPart = (bits: RasterBits, feed: number) => {
    const ec = rasterToEcoords(bits);
    if (!ec.length) return;
    const w = new EgvWriter();
    const step = Math.round(bits.stepMils);
    w.makeEgvData(ec, { feed, board: s.board, rasterStep: s.rasterBottomUp ? step : -step });
    parts.push({ data: stripRedundantCodes(w.out), passes: s.rasterPasses });
  };
  const vectorPart = (polys: Polyline[], feed: number, passes: number, insideCheck: boolean) => {
    let ec = polylinesToEcoords(polys, s.scaleX, s.scaleY);
    if (!ec.length) return;
    if (s.insideFirst) ec = optimizePaths(ec, insideCheck);
    const w = new EgvWriter();
    w.makeEgvData(ec, { feed, board: s.board });
    parts.push({ data: w.out, passes });
  };
  if (ops.raster) {
    if (input.raster) rasterPart(input.raster, s.rasterFeed);
    for (const e of extra) if (e.op === 'raster') rasterPart(e.bits, e.feed);
  }
  if (ops.engrave) {
    if (input.engrave?.length) vectorPart(input.engrave, s.engraveFeed, s.engravePasses, false);
    for (const e of extra) if (e.op === 'engrave') vectorPart(e.polys, e.feed, s.engravePasses, false);
  }
  if (ops.cut) {
    if (input.cut?.length) vectorPart(input.cut, s.cutFeed, s.cutPasses, true);
    for (const e of extra) if (e.op === 'cut') vectorPart(e.polys, e.feed, s.cutPasses, true);
  }
  return joinJobParts(parts);
}

export function bounds(polys: Polyline[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pl of polys)
    for (const [x, y] of pl) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}
