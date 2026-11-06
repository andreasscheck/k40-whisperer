/**
 * SVG-Pfaddaten -> Linienzüge (Polylines). Unterstützt alle Pfadbefehle (M L H V C S Q T A Z,
 * absolut und relativ). Kurven werden nach der Transformation adaptiv unterteilt, so dass die
 * Toleranz in Ausgabeeinheiten (mm) gilt.
 */

export type Pt = [number, number];
export type Polyline = Pt[];
/** Affine Matrix wie SVGMatrix: [a, b, c, d, e, f] */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function multiply(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const CMD_RE = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

interface Token {
  cmd?: string;
  num?: number;
}

function tokenize(d: string): Token[] {
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  CMD_RE.lastIndex = 0;
  while ((m = CMD_RE.exec(d))) {
    if (m[1]) out.push({ cmd: m[1] });
    else out.push({ num: parseFloat(m[2]) });
  }
  return out;
}

/** Arc-Flags dürfen ohne Trenner geschrieben sein ("a1 1 0 00 1 1"), deshalb Sonderbehandlung. */
function fixArcFlags(d: string): string {
  return d.replace(/([Aa])([^MmLlHhVvCcSsQqTtAaZz]*)/g, (_all, cmd: string, args: string) => {
    const nums: string[] = [];
    const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
    let idx = 0;
    let s = args;
    let out = '';
    while (s.length) {
      const pos = idx % 7;
      const ws = s.match(/^[\s,]*/)![0];
      s = s.slice(ws.length);
      if (!s.length) break;
      if (pos === 3 || pos === 4) {
        const f = s[0];
        if (f !== '0' && f !== '1') break;
        nums.push(f);
        s = s.slice(1);
      } else {
        re.lastIndex = 0;
        const mm = s.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
        if (!mm) break;
        nums.push(mm[0]);
        s = s.slice(mm[0].length);
      }
      idx++;
    }
    out = cmd + ' ' + nums.join(' ') + ' ' + s;
    return out;
  });
}

class Flattener {
  polylines: Polyline[] = [];
  private cur: Polyline | null = null;
  constructor(
    private m: Mat,
    private tol: number,
  ) {}

  moveTo(x: number, y: number) {
    this.finish();
    this.cur = [apply(this.m, x, y)];
  }
  lineTo(x: number, y: number) {
    if (!this.cur) this.cur = [apply(this.m, x, y)];
    else this.cur.push(apply(this.m, x, y));
  }
  cubic(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    const p0 = apply(this.m, x0, y0);
    const p1 = apply(this.m, x1, y1);
    const p2 = apply(this.m, x2, y2);
    const p3 = apply(this.m, x3, y3);
    if (!this.cur) this.cur = [p0];
    subdivideCubic(p0, p1, p2, p3, this.tol, this.cur, 0);
    this.cur.push(p3);
  }
  close(x: number, y: number) {
    if (this.cur) {
      const p = apply(this.m, x, y);
      const last = this.cur[this.cur.length - 1];
      if (last[0] !== p[0] || last[1] !== p[1]) this.cur.push(p);
    }
  }
  finish() {
    if (this.cur && this.cur.length > 1) this.polylines.push(this.cur);
    this.cur = null;
  }
}

function subdivideCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, out: Polyline, depth: number) {
  // Flachheitstest: Abstand der Kontrollpunkte zur Sehne
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx);
  const d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx);
  const len2 = dx * dx + dy * dy;
  const flat = len2 > 1e-18 ? (d1 + d2) * (d1 + d2) < tol * tol * len2 * 4 : Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) < tol;
  if (flat || depth > 16) return;
  const m01: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const m12: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const m23: Pt = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const a: Pt = [(m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2];
  const b: Pt = [(m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2];
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  subdivideCubic(p0, m01, a, mid, tol, out, depth + 1);
  out.push(mid);
  subdivideCubic(mid, b, m23, p3, tol, out, depth + 1);
}

/** SVG-Bogen -> kubische Béziers (Endpunkt-Parametrisierung, SVG-Spezifikation F.6). */
function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): number[][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  if (fs && dth < 0) dth += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const delta = dth / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: number[][] = [];
  let th = th1;
  for (let i = 0; i < segs; i++) {
    const c1 = Math.cos(th);
    const s1 = Math.sin(th);
    const c2 = Math.cos(th + delta);
    const s2 = Math.sin(th + delta);
    const ep = (c: number, s: number): Pt => [cx + rx * c * cos - ry * s * sin, cy + rx * c * sin + ry * s * cos];
    const p1 = ep(c1, s1);
    const p2 = ep(c2, s2);
    const d1: Pt = [-rx * s1 * cos - ry * c1 * sin, -rx * s1 * sin + ry * c1 * cos];
    const d2: Pt = [-rx * s2 * cos - ry * c2 * sin, -rx * s2 * sin + ry * c2 * cos];
    out.push([p1[0] + t * d1[0], p1[1] + t * d1[1], p2[0] - t * d2[0], p2[1] - t * d2[1], i === segs - 1 ? x2 : p2[0], i === segs - 1 ? y2 : p2[1]]);
    th += delta;
  }
  return out;
}

export function flattenPath(d: string, m: Mat = IDENTITY, tol = 0.01): Polyline[] {
  const toks = tokenize(fixArcFlags(d));
  const f = new Flattener(m, tol);
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lcx = 0; // letzter Kontrollpunkt (für S/T)
  let lcy = 0;
  let lastCmd = '';
  const num = () => {
    const t = toks[i];
    if (!t || t.num === undefined) throw new Error('Ungültige Pfaddaten');
    i++;
    return t.num;
  };
  const hasNum = () => i < toks.length && toks[i].num !== undefined;

  while (i < toks.length) {
    if (toks[i].cmd) {
      cmd = toks[i].cmd!;
      i++;
    } else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      f.close(sx, sy);
      x = sx;
      y = sy;
      lastCmd = 'Z';
      // nach Z kann direkt ein neuer Befehl kommen; Linienzug bleibt "offen" für folgendes L
      continue;
    }
    if (!hasNum()) continue;
    do {
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      switch (C) {
        case 'M': {
          x = ox + num();
          y = oy + num();
          sx = x;
          sy = y;
          f.moveTo(x, y);
          cmd = rel ? 'l' : 'L';
          lastCmd = 'M';
          break;
        }
        case 'L':
          if (lastCmd === 'Z') f.moveTo(x, y);
          x = ox + num();
          y = oy + num();
          f.lineTo(x, y);
          break;
        case 'H':
          if (lastCmd === 'Z') f.moveTo(x, y);
          x = ox + num();
          f.lineTo(x, y);
          break;
        case 'V':
          if (lastCmd === 'Z') f.moveTo(x, y);
          y = oy + num();
          f.lineTo(x, y);
          break;
        case 'C': {
          if (lastCmd === 'Z') f.moveTo(x, y);
          const x1 = ox + num();
          const y1 = oy + num();
          const x2 = ox + num();
          const y2 = oy + num();
          const xe = ox + num();
          const ye = oy + num();
          f.cubic(x, y, x1, y1, x2, y2, xe, ye);
          lcx = x2;
          lcy = y2;
          x = xe;
          y = ye;
          break;
        }
        case 'S': {
          if (lastCmd === 'Z') f.moveTo(x, y);
          const x1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * x - lcx : x;
          const y1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * y - lcy : y;
          const x2 = ox + num();
          const y2 = oy + num();
          const xe = ox + num();
          const ye = oy + num();
          f.cubic(x, y, x1, y1, x2, y2, xe, ye);
          lcx = x2;
          lcy = y2;
          x = xe;
          y = ye;
          break;
        }
        case 'Q':
        case 'T': {
          if (lastCmd === 'Z') f.moveTo(x, y);
          let qx: number;
          let qy: number;
          if (C === 'Q') {
            qx = ox + num();
            qy = oy + num();
          } else {
            qx = lastCmd === 'Q' || lastCmd === 'T' ? 2 * x - lcx : x;
            qy = lastCmd === 'Q' || lastCmd === 'T' ? 2 * y - lcy : y;
          }
          const xe = ox + num();
          const ye = oy + num();
          f.cubic(x, y, x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), xe + (2 / 3) * (qx - xe), ye + (2 / 3) * (qy - ye), xe, ye);
          lcx = qx;
          lcy = qy;
          x = xe;
          y = ye;
          break;
        }
        case 'A': {
          if (lastCmd === 'Z') f.moveTo(x, y);
          const rx = num();
          const ry = num();
          const rot = num();
          const fa = num();
          const fs = num();
          const xe = ox + num();
          const ye = oy + num();
          if (xe !== x || ye !== y) {
            for (const c of arcToCubics(x, y, rx, ry, rot, fa, fs, xe, ye)) {
              f.cubic(x, y, c[0], c[1], c[2], c[3], c[4], c[5]);
              x = c[4];
              y = c[5];
            }
          }
          x = xe;
          y = ye;
          break;
        }
        default:
          i++;
      }
      if (C !== 'M') lastCmd = C;
    } while (hasNum());
  }
  f.finish();
  return f.polylines;
}

/** Einfache Formen als Pfaddaten */
export function rectPath(x: number, y: number, w: number, h: number, rxIn: number, ryIn: number): string {
  if (w <= 0 || h <= 0) return '';
  let rx = rxIn;
  let ry = ryIn;
  if (rx <= 0 && ry > 0) rx = ry;
  if (ry <= 0 && rx > 0) ry = rx;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return (
    `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
    `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
  );
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return '';
  return `M${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}Z`;
}

export function pointsPath(points: string, close: boolean): string {
  const n = (points.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  if (n.length < 4) return '';
  let d = `M${n[0]} ${n[1]}`;
  for (let i = 2; i + 1 < n.length; i += 2) d += `L${n[i]} ${n[i + 1]}`;
  return close ? d + 'Z' : d;
}
