import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EgvWriter, stripRedundantCodes, type ECoord } from '../src/core/egv';
import { speedCode, type BoardName } from '../src/core/laserSpeed';

const load = (n: string) => JSON.parse(readFileSync(new URL(`./golden/${n}.json`, import.meta.url), 'utf8'));
const str = (a: number[]) => { let s = ""; for (const c of a) s += String.fromCharCode(c); return s; };

describe('Golden-Tests gegen das Original (K40 Whisperer egv.py)', () => {
  it('Speed-Codes', () => {
    for (const c of load('speed')) {
      expect(speedCode(c.speed, c.step, c.board as BoardName), JSON.stringify(c)).toBe(c.code);
    }
  });

  it('Vektor-Daten', () => {
    const cases = load('vector');
    cases.forEach((c: any, i: number) => {
      const w = new EgvWriter();
      w.makeEgvData(c.ecoords as ECoord[], { startX: c.startX, startY: c.startY, feed: c.feed, board: c.board, rapidFeedRate: c.rapid });
      expect(str(w.out), `Fall ${i}`).toBe(str(c.data));
    });
  });

  it('Raster-Daten', () => {
    const cases = load('raster');
    cases.forEach((c: any, i: number) => {
      const w = new EgvWriter();
      w.makeEgvData(c.ecoords as ECoord[], { startX: c.startX, startY: c.startY, feed: c.feed, board: c.board, rasterStep: c.rasterStep, rapidFeedRate: c.rapid });
      expect(str(w.out), `Fall ${i}`).toBe(str(c.data));
      expect(str(stripRedundantCodes(w.out)), `Fall ${i} (gestrippt)`).toBe(str(c.stripped));
    });
  });

  it('Eilgang-Bewegungen (Joggen)', () => {
    for (const c of load('move')) {
      const w = new EgvWriter();
      w.makeMoveData(c.dx, c.dy);
      expect(str(w.out)).toBe(str(c.data));
    }
  });

  it('Langsame Eilgänge', () => {
    for (const c of load('rapid')) {
      const w = new EgvWriter();
      w.makeEgvRapid(c.dx, c.dy, c.feed, c.board);
      expect(str(w.out)).toBe(str(c.data));
    }
  });
});
