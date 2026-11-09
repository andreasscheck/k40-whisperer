/**
 * Parametrische Grundformen (Rechteck, Kreis/Ellipse, Linie, Vieleck, Testmuster).
 * Reine Geometrie in mm, Ursprung = linke obere Ecke der Form, y nach unten.
 */
import { ellipsePath, rectPath, type Polyline } from './pathFlatten';

export type ShapeOp = 'cut' | 'engrave' | 'fill';

export interface RectShape {
  kind: 'rect';
  w: number;
  h: number;
  r: number;
  op: ShapeOp;
  /** Rahmen um ein anderes Objekt (target = Objekt-ID, null = alle übrigen Objekte) */
  frame?: { target: number | null; margin: number };
}
export interface EllipseShape {
  kind: 'ellipse';
  w: number;
  h: number;
  op: ShapeOp;
}
export interface LineShape {
  kind: 'line';
  length: number;
  /** Grad, 0 = waagrecht nach rechts, positiv = gegen den Uhrzeigersinn */
  angle: number;
  op: 'cut' | 'engrave';
}
export interface PolygonShape {
  kind: 'polygon';
  n: number;
  /** Umkreis-Durchmesser */
  d: number;
  op: ShapeOp;
}
export interface TestShape {
  kind: 'test';
  /** raster = gefüllte Felder (Raster-Gravur), vector = Quadrat-Konturen (Vektor-Gravur) */
  mode: 'raster' | 'vector';
  count: number;
  vMin: number;
  vMax: number;
  size: number;
  gap: number;
  labels: boolean;
}
export type Shape = RectShape | EllipseShape | LineShape | PolygonShape | TestShape;
export type OutlineShape = Exclude<Shape, TestShape>;

export const SHAPE_NAMES: Record<Shape['kind'], string> = {
  rect: 'Rechteck',
  ellipse: 'Kreis',
  line: 'Linie',
  polygon: 'Vieleck',
  test: 'Testmuster',
};

export const TEST_SPEEDS = { raster: { vMin: 100, vMax: 300 }, vector: { vMin: 5, vMax: 25 } } as const;

export function defaultShape(kind: Shape['kind']): Shape {
  switch (kind) {
    case 'rect':
      return { kind, w: 40, h: 30, r: 0, op: 'cut' };
    case 'ellipse':
      return { kind, w: 30, h: 30, op: 'cut' };
    case 'line':
      return { kind, length: 50, angle: 0, op: 'cut' };
    case 'polygon':
      return { kind, n: 6, d: 30, op: 'cut' };
    case 'test':
      return { kind, mode: 'raster', count: 5, ...TEST_SPEEDS.raster, size: 10, gap: 3, labels: true };
  }
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Kontur als SVG-Pfad (lokale mm-Koordinaten) und Größe der Form. */
export function shapeOutline(s: OutlineShape): { d: string; w: number; h: number; closed: boolean } {
  switch (s.kind) {
    case 'rect':
      return { d: rectPath(0, 0, s.w, s.h, s.r, s.r), w: s.w, h: s.h, closed: true };
    case 'ellipse':
      return { d: ellipsePath(s.w / 2, s.h / 2, s.w / 2, s.h / 2), w: s.w, h: s.h, closed: true };
    case 'line': {
      const a = (s.angle * Math.PI) / 180;
      const dx = r6(s.length * Math.cos(a));
      const dy = r6(-s.length * Math.sin(a));
      const x0 = dx < 0 ? -dx : 0;
      const y0 = dy < 0 ? -dy : 0;
      return { d: `M${x0} ${y0}L${r6(x0 + dx)} ${r6(y0 + dy)}`, w: Math.abs(dx), h: Math.abs(dy), closed: false };
    }
    case 'polygon': {
      const R = s.d / 2;
      const pts: [number, number][] = [];
      for (let k = 0; k < s.n; k++) {
        const a = -Math.PI / 2 + (k * 2 * Math.PI) / s.n;
        pts.push([R * Math.cos(a), R * Math.sin(a)]);
      }
      const minX = Math.min(...pts.map((p) => p[0]));
      const minY = Math.min(...pts.map((p) => p[1]));
      const maxX = Math.max(...pts.map((p) => p[0]));
      const maxY = Math.max(...pts.map((p) => p[1]));
      const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r6(x - minX)} ${r6(y - minY)}`).join('') + 'Z';
      return { d, w: r6(maxX - minX), h: r6(maxY - minY), closed: true };
    }
  }
}

export interface TestField {
  x: number;
  y: number;
  size: number;
  feed: number;
}

export const TEST_FONT_MM = 3;

/** Felder des Testmusters: eine Reihe Quadrate mit steigender Geschwindigkeit. */
export function testLayout(t: TestShape): { fields: TestField[]; w: number; h: number } {
  const fields: TestField[] = [];
  for (let i = 0; i < t.count; i++) {
    const v = t.count > 1 ? t.vMin + ((t.vMax - t.vMin) * i) / (t.count - 1) : t.vMin;
    fields.push({ x: i * (t.size + t.gap), y: 0, size: t.size, feed: Math.round(v * 10) / 10 });
  }
  const w = t.count * t.size + (t.count - 1) * t.gap;
  const h = t.size + (t.labels ? TEST_FONT_MM + 1.5 : 0);
  return { fields, w, h };
}

export function squarePoly(x: number, y: number, s: number): Polyline {
  return [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
}

export const fmtNum = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');
