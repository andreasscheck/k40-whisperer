import { describe, expect, it } from 'vitest';
import { ellipsePath, flattenPath, rectPath } from '../src/core/pathFlatten';
import { DEFAULT_JOB, buildJob, grayToBits, optimizePaths, polylinesToEcoords, rasterToEcoords } from '../src/core/job';
import { simulateEgv } from '../src/core/egvSim';

describe('Pfade', () => {
  it('Rechteck und Kreis', () => {
    const [r] = flattenPath(rectPath(1, 2, 10, 5, 0, 0));
    expect(r).toEqual([[1, 2], [11, 2], [11, 7], [1, 7], [1, 2]]);
    const [c] = flattenPath(ellipsePath(0, 0, 10, 10), undefined, 0.01);
    for (const [x, y] of c) expect(Math.abs(Math.hypot(x, y) - 10)).toBeLessThan(0.02);
    expect(c.length).toBeGreaterThan(40);
  });

  it('relative Befehle, kompakte Arc-Flags, mehrere Unterpfade', () => {
    const p = flattenPath('m10 10 l5 0 0 5z m20 0 h5 v5 h-5z M0 0a5 5 0 105 5');
    expect(p.length).toBe(3);
    expect(p[0]).toEqual([[10, 10], [15, 10], [15, 15], [10, 10]]);
    expect(p[1][0]).toEqual([30, 10]);
    const last = p[2][p[2].length - 1];
    expect(last[0]).toBeCloseTo(5);
    expect(last[1]).toBeCloseTo(5);
  });

  it('Transformation wird angewendet', () => {
    const [pl] = flattenPath('M0 0 L1 0', [2, 0, 0, 3, 10, 20]);
    expect(pl).toEqual([[10, 20], [12, 20]]);
  });
});

describe('Schneidreihenfolge', () => {
  it('innen liegende Kontur wird zuerst geschnitten', () => {
    const outer = flattenPath(rectPath(0, 0, 100, 100, 0, 0))[0];
    const inner = flattenPath(rectPath(40, 40, 20, 20, 0, 0))[0];
    const ec = optimizePaths(polylinesToEcoords([outer, inner]), true);
    // erster Punkt gehört zur inneren Kontur (x zwischen 40 und 60 mm)
    expect(ec[0][0] * 25.4).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(ec[0][0] * 25.4).toBeLessThanOrEqual(60 + 1e-6);
  });
});

describe('Auftrag Ende-zu-Ende (über Simulator geprüft)', () => {
  it('Schnitt eines 25,4-mm-Quadrats', () => {
    const sq = flattenPath(rectPath(10, 10, 25.4, 25.4, 0, 0));
    const data = buildJob({ cut: sq }, { raster: false, engrave: false, cut: true }, DEFAULT_JOB);
    const sim = simulateEgv(data);
    expect([sim.endX, sim.endY]).toEqual([0, 0]);
    const burn = sim.segments.filter((s) => s.laser);
    const xs = burn.flatMap((s) => [s.x0, s.x1]);
    const ys = burn.flatMap((s) => [s.y0, s.y1]);
    expect(Math.min(...xs)).toBe(394); // 10 mm
    expect(Math.max(...xs)).toBe(1394); // 10 mm + 1 Zoll
    expect(Math.max(...ys)).toBe(-394);
    expect(Math.min(...ys)).toBe(-1394);
    const len = burn.reduce((a, s) => a + Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0);
    expect(len).toBe(4000);
  });

  it('Raster: Schwellwert, Dithering, Kopf kehrt zurück', () => {
    const width = 300;
    const rows = 50;
    const gray = new Uint8Array(width * rows).fill(255);
    for (let r = 10; r < 30; r++) for (let x = 50; x < 150; x++) gray[r * width + x] = 0;
    const bits = grayToBits({ width, rows, stepMils: 2, gray }, { mode: 'threshold', threshold: 128, invert: false, gamma: 1 });
    expect(rasterToEcoords(bits).length).toBe(40);
    const data = buildJob({ raster: bits }, { raster: true, engrave: false, cut: false }, DEFAULT_JOB);
    const sim = simulateEgv(data);
    const burn = sim.segments.filter((s) => s.laser);
    expect(Math.min(...burn.flatMap((s) => [s.x0, s.x1]))).toBe(50);
    expect(Math.max(...burn.flatMap((s) => [s.x0, s.x1]))).toBe(150);
    expect(new Set(burn.map((s) => s.y0)).size).toBe(20);
    expect(sim.endX).toBe(0);

    const mid = new Uint8Array(width * rows).fill(128);
    const d = grayToBits({ width, rows, stepMils: 2, gray: mid }, { mode: 'dither', threshold: 128, invert: false, gamma: 1 });
    const frac = d.bits.reduce((a, b) => a + b, 0) / d.bits.length;
    expect(frac).toBeGreaterThan(0.4);
    expect(frac).toBeLessThan(0.6);
  });
});
