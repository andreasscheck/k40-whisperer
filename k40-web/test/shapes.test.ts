import { describe, expect, it } from 'vitest';
import { flattenPath } from '../src/core/pathFlatten';
import { DEFAULT_JOB, buildJob, rasterToEcoords } from '../src/core/job';
import { simulateEgv } from '../src/core/egvSim';
import { defaultShape, shapeOutline, testLayout, type TestShape } from '../src/core/shapes';
import { composeExtras, composeVectors, unionBox, type Item } from '../src/io/layout';

const fakeItem = (id: number, x: number, y: number, w: number, h: number, extra: Partial<Item> = {}): Item =>
  ({ id, name: 'x', x, y, version: 1, design: { name: 'x', widthMm: w, heightMm: h, cut: [], engrave: [], hasRaster: false, preview: null, warnings: [] }, ...extra }) as unknown as Item;

describe('Formen', () => {
  it('Linie: Größe aus Länge und Winkel, Start im Ursprung des Rahmens', () => {
    const o = shapeOutline({ kind: 'line', length: 10, angle: 90, op: 'cut' });
    expect(o.w).toBeCloseTo(0);
    expect(o.h).toBeCloseTo(10);
    const [pl] = flattenPath(o.d);
    expect(pl[0][1]).toBeCloseTo(10); // nach oben: Start unten
    expect(pl[1][1]).toBeCloseTo(0);
    const d = shapeOutline({ kind: 'line', length: 10, angle: 135, op: 'cut' });
    const [p2] = flattenPath(d.d);
    for (const [x, y] of p2) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('Vieleck liegt im Rahmen und ist geschlossen', () => {
    const o = shapeOutline({ kind: 'polygon', n: 6, d: 30, op: 'cut' });
    expect(o.h).toBeCloseTo(30);
    expect(o.w).toBeCloseTo(30 * Math.cos(Math.PI / 6));
    const [pl] = flattenPath(o.d);
    expect(pl.length).toBe(7);
    expect(pl[0]).toEqual(pl[6]);
  });

  it('Testmuster: Geschwindigkeiten linear verteilt', () => {
    const t = { ...defaultShape('test'), count: 5, vMin: 100, vMax: 300 } as TestShape;
    const { fields, w } = testLayout(t);
    expect(fields.map((f) => f.feed)).toEqual([100, 150, 200, 250, 300]);
    expect(w).toBe(5 * 10 + 4 * 3);
  });
});

describe('Mehrere Objekte', () => {
  it('Vektoren werden relativ zum Auftragsursprung verschoben', () => {
    const a = fakeItem(1, 50, 20, 10, 10);
    a.design.cut = [[[0, 0], [10, 0]]];
    const b = fakeItem(2, 10, 40, 5, 5);
    b.design.engrave = [[[0, 0], [5, 5]]];
    const box = unionBox([a, b])!;
    expect(box).toEqual({ x: 10, y: 20, w: 50, h: 25 });
    const v = composeVectors([a, b], box.x, box.y);
    expect(v.cut[0][0]).toEqual([40, 0]);
    expect(v.engrave[0][1]).toEqual([5, 25]);
  });

  it('Testfelder: eigene Geschwindigkeit, Rasterversatz auf Zeilenraster', () => {
    const t = { ...defaultShape('test'), count: 2, vMin: 100, vMax: 200, size: 2.54, gap: 2.54, labels: false } as TestShape;
    const lay = testLayout(t);
    const it = fakeItem(1, 25.4, 12.7, lay.w, lay.h, { shape: t, fields: lay.fields });
    const ex = composeExtras([it], 0, 0, { scaleX: 1, scaleY: 1, rasterStepMils: 2 });
    expect(ex.map((e) => e.feed)).toEqual([100, 200]);
    const r0 = ex[0];
    if (r0.op !== 'raster') throw new Error('Raster erwartet');
    expect(r0.bits.width).toBe(100);
    expect(r0.bits.rows).toBe(50);
    expect([r0.bits.offsetX, r0.bits.offsetY]).toEqual([1000, 500]);
    const ec = rasterToEcoords(r0.bits);
    expect(ec[0]).toEqual([1, -0.5, 1]);

    const data = buildJob({ extra: ex }, { raster: true, engrave: false, cut: false }, DEFAULT_JOB);
    const sim = simulateEgv(data);
    const burn = sim.segments.filter((s) => s.laser);
    const xs = burn.flatMap((s) => [s.x0, s.x1]);
    expect(Math.min(...xs)).toBe(1000);
    expect(Math.max(...xs)).toBe(1300); // zweites Feld: 1000 + 100 + 100 Abstand + 100
    expect([sim.endX, sim.endY]).toEqual([0, 0]);
  });

  it('Vektor-Testfelder werden mit ihrer Geschwindigkeit geschnitten', () => {
    const t = { ...defaultShape('test'), mode: 'vector', count: 3, vMin: 5, vMax: 25, size: 10, gap: 2, labels: false } as TestShape;
    const lay = testLayout(t);
    const it = fakeItem(1, 0, 0, lay.w, lay.h, { shape: t, fields: lay.fields });
    const ex = composeExtras([it], 0, 0, { scaleX: 1, scaleY: 1, rasterStepMils: 2 });
    expect(ex.map((e) => [e.op, e.feed])).toEqual([
      ['engrave', 5],
      ['engrave', 15],
      ['engrave', 25],
    ]);
    // Testfelder tauchen nicht zusätzlich in den normalen Gravurpfaden auf
    it.design.engrave = lay.fields.map(() => [[0, 0], [1, 1]]);
    expect(composeVectors([it], 0, 0).engrave.length).toBe(0);
    const data = buildJob({ extra: ex }, { raster: false, engrave: true, cut: false }, DEFAULT_JOB);
    const speeds = new Set(simulateEgv(data).segments.filter((s) => s.laser).map((s) => s.speed));
    expect(speeds.size).toBe(3);
  });
});
