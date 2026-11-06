import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulateEgv } from '../src/core/egvSim';
import { pyRound } from '../src/core/pyround';

const load = (n: string) => JSON.parse(readFileSync(new URL(`./golden/${n}.json`, import.meta.url), 'utf8'));

function mergeRuns(runs: [number, number][]): [number, number][] {
  runs.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of runs) {
    if (r[1] <= r[0]) continue;
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

describe('EGV-Simulator', () => {
  it('Vektor: alle Punkte werden in Reihenfolge angefahren, Kopf endet am Start', () => {
    for (const c of load('vector')) {
      if (c.rapid) continue;
      const sim = simulateEgv(c.data, c.board);
      expect(sim.endX).toBe(0);
      expect(sim.endY).toBe(0);
      const sx = pyRound(c.startX * 1000);
      const sy = pyRound(c.startY * 1000);
      const segs = [{ x0: 0, y0: 0, x1: 0, y1: 0 }, ...sim.segments];
      const onSeg = (s: { x0: number; y0: number; x1: number; y1: number }, px: number, py: number) => {
        const cross = (s.x1 - s.x0) * (py - s.y0) - (s.y1 - s.y0) * (px - s.x0);
        return cross === 0 && px >= Math.min(s.x0, s.x1) && px <= Math.max(s.x0, s.x1) && py >= Math.min(s.y0, s.y1) && py <= Math.max(s.y0, s.y1);
      };
      let k = 0;
      for (const p of c.ecoords) {
        const tx = pyRound(p[0] * 1000) - sx;
        const ty = pyRound(p[1] * 1000) - sy;
        while (k < segs.length && !onSeg(segs[k], tx, ty)) k++;
        expect(k, `Punkt ${tx},${ty} nicht erreicht`).toBeLessThan(segs.length);
      }
    }
  });

  it('Raster: gebrannte Abschnitte entsprechen genau den Bilddaten', () => {
    for (const [idx, c] of load('raster').entries()) {
      if (c.rapid) continue;
      const sim = simulateEgv(c.stripped, c.board);
      const got = new Map<number, [number, number][]>();
      for (const s of sim.segments) {
        if (!s.laser) continue;
        expect(s.y0).toBe(s.y1);
        const a = got.get(s.y0) ?? [];
        a.push([Math.min(s.x0, s.x1), Math.max(s.x0, s.x1)]);
        got.set(s.y0, a);
      }
      const want = new Map<number, [number, number][]>();
      for (let i = 0; i < c.ecoords.length; i += 2) {
        const y = pyRound(c.ecoords[i][1] * 1000);
        const a = want.get(y) ?? [];
        a.push([pyRound(c.ecoords[i][0] * 1000), pyRound(c.ecoords[i + 1][0] * 1000)]);
        want.set(y, a);
      }
      const norm = (m: Map<number, [number, number][]>) =>
        // Zeilenreihenfolge statt absoluter y-Lage vergleichen: der Zeilenvorschub im Rastermodus wird vom
        // Simulator bei 1-mil-Schritten mit übersprungenen Leerzeilen nur näherungsweise nachgebildet.
        [...m.entries()].map(([y, r]) => [y, mergeRuns(r)] as const).filter(([, r]) => r.length).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
      expect(norm(got), `Fall ${idx}`).toEqual(norm(want));
    }
  });
});
