/**
 * Erzeugung von EGV-Daten (LHYMICRO-GL-Befehlsstrom) für den K40 / M2-Nano-Controller.
 *
 * Diese Datei ist eine sehr genaue Portierung von egv.py aus K40 Whisperer
 * (Copyright (C) 2017-2022 Scorch, GPL). Die Ausgabe wird in den Tests Byte für Byte
 * mit dem Original verglichen – bitte bei Änderungen die Golden-Tests laufen lassen.
 *
 * Koordinaten: Zoll, x nach rechts, y nach OBEN (wie im Original).
 */
import { pyRound } from './pyround';
import { speedCode, type BoardName } from './laserSpeed';

/** [x, y, loop] – Punkte mit gleicher loop-Nummer werden mit Laser verbunden. */
export type ECoord = [number, number, number];

const ch = (s: string) => s.charCodeAt(0);

export const RIGHT = 66; // 'B'
export const LEFT = 84; // 'T'
export const UP = 76; // 'L'
export const DOWN = 82; // 'R'
export const ANGLE = 77; // 'M'
export const ON = 68; // 'D'
export const OFF = 85; // 'U'

export interface EgvOptions {
  startX?: number;
  startY?: number;
  feed: number; // mm/s
  board?: BoardName;
  rasterStep?: number; // Tausendstel Zoll, negativ = von oben nach unten
  flipXOffset?: number;
  rapidFeedRate?: number;
  useLaser?: boolean;
}

export class EgvWriter {
  readonly out: number[] = [];
  private modalDir = 0;
  private modalDist = 0;
  private modalOn = false;
  private modalAX = 0;
  private modalAY = 0;

  private write(code: number) {
    this.out.push(code);
  }

  move(direction: number, distance: number, laserOn = false, angleDirs?: [number, number]) {
    const ad = angleDirs ?? [this.modalAX, this.modalAY];
    if (direction === this.modalDir && laserOn === this.modalOn && ad[0] === this.modalAX && ad[1] === this.modalAY) {
      this.modalDist += distance;
    } else {
      this.flush();
      if (laserOn !== this.modalOn) {
        this.write(laserOn ? ON : OFF);
        this.modalOn = laserOn;
      }
      if (direction === ANGLE) {
        if (ad[0] !== this.modalAX) {
          this.write(ad[0]);
          this.modalAX = ad[0];
        }
        if (ad[1] !== this.modalAY) {
          this.write(ad[1]);
          this.modalAY = ad[1];
        }
      }
      this.modalDir = direction;
      this.modalDist = distance;
      if (direction === RIGHT || direction === LEFT) this.modalAX = direction;
      if (direction === UP || direction === DOWN) this.modalAY = direction;
    }
  }

  flush(laserOn?: boolean) {
    if (this.modalDist > 0) {
      this.write(this.modalDir);
      for (const c of makeDistance(this.modalDist)) this.write(c);
    }
    if (laserOn !== undefined && laserOn !== this.modalOn) {
      this.write(laserOn ? ON : OFF);
      this.modalOn = laserOn;
    }
    this.modalDist = 0;
  }

  makeDirDist(dxmils: number, dymils: number, laserOn = false) {
    const adx = Math.abs(dxmils);
    const ady = Math.abs(dymils);
    if (adx > 0 || ady > 0) {
      if (ady > 0) this.move(dymils > 0 ? UP : DOWN, ady, laserOn);
      if (adx > 0) this.move(dxmils > 0 ? RIGHT : LEFT, adx, laserOn);
    }
  }

  makeCutLine(dxmils: number, dymils: number, spindle: boolean) {
    const XCODE = dxmils < 0 ? LEFT : RIGHT;
    const YCODE = dymils < 0 ? DOWN : UP;
    if (Math.abs(dxmils - pyRound(dxmils)) > 0 || Math.abs(dymils - pyRound(dymils)) > 0) {
      throw new Error('Distance values should be integer value (inches*1000)');
    }
    const adx = Math.abs(dxmils / 1000.0);
    const ady = Math.abs(dymils / 1000.0);

    if (dxmils === 0) {
      this.move(YCODE, Math.abs(dymils), spindle);
    } else if (dymils === 0) {
      this.move(XCODE, Math.abs(dxmils), spindle);
    } else if (dxmils === dymils) {
      this.move(ANGLE, Math.abs(dxmils), spindle, [XCODE, YCODE]);
    } else {
      let slope: number, n: number, CODE: number;
      if (adx > ady) {
        slope = ady / adx;
        n = Math.trunc(Math.abs(dxmils));
        CODE = XCODE;
      } else {
        slope = adx / ady;
        n = Math.trunc(Math.abs(dymils));
        CODE = YCODE;
      }
      let Lh = 0;
      let d1 = 0;
      let d2 = 0;
      let d1cnt = 0;
      let d2cnt = 0;
      for (let i = 1; i <= n; i++) {
        const h = pyRound(i * slope);
        if (h === Lh) {
          d1 += 1;
          if (d2 > 0) {
            this.move(ANGLE, d2, spindle, [XCODE, YCODE]);
            d2cnt += d2;
            d2 = 0;
          }
        } else {
          d2 += 1;
          if (d1 > 0) {
            this.move(CODE, d1, spindle);
            d1cnt += d1;
            d1 = 0;
          }
        }
        Lh = h;
      }
      if (d1 > 0) {
        this.move(CODE, d1, spindle);
        d1cnt += d1;
      }
      if (d2 > 0) {
        this.move(ANGLE, d2, spindle, [XCODE, YCODE]);
        d2cnt += d2;
      }
      const DX = d2cnt;
      const DY = d1cnt + d2cnt;
      const error = adx < ady ? Math.max(DX - Math.abs(dxmils), DY - Math.abs(dymils)) : Math.max(DY - Math.abs(dxmils), DX - Math.abs(dymils));
      if (error > 0) throw new Error(`egv: Error delta = ${error}`);
    }
  }

  private writeStr(s: string) {
    for (let i = 0; i < s.length; i++) this.write(s.charCodeAt(i));
  }

  private makeSpeed(feed: number, board: BoardName, rasterStep = 0): string {
    return speedCode(feed, Math.abs(rasterStep), board);
  }

  /** Eilgang-Befehl für Joggen: I <moves> S1P */
  makeMoveData(dxmils: number, dymils: number) {
    if (Math.abs(dxmils) + Math.abs(dymils) > 0) {
      this.write(ch('I'));
      this.makeDirDist(dxmils, dymils);
      this.flush();
      this.writeStr('S1P');
    }
  }

  private ecoordAdj(e: ECoord, scale: number, flipXOffset: number): ECoord {
    const e0 = flipXOffset > 0 ? pyRound((flipXOffset - e[0]) * scale) : pyRound(e[0] * scale);
    const e1 = pyRound(e[1] * scale);
    return [e0, e1, e[2]];
  }

  makeEgvData(ecoordsIn: ECoord[], opts: EgvOptions) {
    const board = opts.board ?? 'M2';
    const rasterStep = opts.rasterStep ?? 0;
    const flipX = opts.flipXOffset ?? 0;
    const rapidFeed = opts.rapidFeedRate ?? 0;
    const useLaser = opts.useLaser ?? true;
    const feed = opts.feed;
    const scale = 1000.0;
    const startX = pyRound((opts.startX ?? 0) * scale);
    const startY = pyRound((opts.startY ?? 0) * scale);
    const spindle = useLaser;
    const speed = this.makeSpeed(feed, board, rasterStep);
    const minRapid = 5;

    if (rasterStep === 0) {
      this.writeStr(speed);
      let [lastx, lasty, lastLoop] = this.ecoordAdj(ecoordsIn[0], scale, flipX);
      if (!rapidFeed) this.makeDirDist(lastx - startX, lasty - startY);
      this.flush(false);
      this.write(ch('N'));
      this.write(lasty - startY <= 0 ? DOWN : UP);
      this.write(lastx - startX >= 0 ? RIGHT : LEFT);
      this.writeStr('S1E');
      let laser = false;
      if (rapidFeed) this.rapidMoveSlow(lastx - startX, lasty - startY, rapidFeed, feed, board);
      for (let i = 1; i < ecoordsIn.length; i++) {
        const [e0, e1, e2] = this.ecoordAdj(ecoordsIn[i], scale, flipX);
        if (e2 === lastLoop && !laser) laser = true;
        else if (e2 !== lastLoop && laser) laser = false;
        const dx = e0 - lastx;
        const dy = e1 - lasty;
        if (Math.abs(dx) + Math.abs(dy) > 0) {
          if (laser) {
            this.makeCutLine(dx, dy, spindle);
          } else if ((Math.abs(dx) < minRapid && Math.abs(dy) < minRapid) || rapidFeed) {
            this.rapidMoveSlow(dx, dy, rapidFeed, feed, board);
          } else {
            this.rapidMoveFast(dx, dy);
          }
        }
        lastx = e0;
        lasty = e1;
        lastLoop = e2;
      }
      const dx = startX - lastx;
      const dy = startY - lasty;
      if ((Math.abs(dx) < minRapid && Math.abs(dy) < minRapid) || rapidFeed) {
        this.rapidMoveSlow(dx, dy, rapidFeed, feed, board);
      } else {
        this.rapidMoveFast(dx, dy);
      }
    } else {
      // ---------------------------- Raster ----------------------------
      let rapidFlag = true;
      const scanline: ECoord[][] = [];
      let scanlineY: number | null = null;
      const n = ecoordsIn.length;
      const pushPoint = (p: ECoord) => {
        const y = p[1];
        if (y !== scanlineY) {
          scanline.push([p]);
          scanlineY = y;
        } else if (Boolean(flipX) !== rasterStep > 0) {
          scanline[scanline.length - 1].unshift(p);
        } else {
          scanline[scanline.length - 1].push(p);
        }
      };
      if (rasterStep < 0) for (let i = 0; i < n; i++) pushPoint(ecoordsIn[i]);
      else for (let i = n - 1; i >= 0; i--) pushPoint(ecoordsIn[i]);

      let [lastx, lasty] = this.ecoordAdj(scanline[0][0], scale, flipX);
      const DXstart = lastx - startX;
      const DYstart = lasty - startY;
      if (rapidFeed) this.makeEgvRapid(DXstart, DYstart, rapidFeed, board, false);
      this.writeStr(speed);
      if (!rapidFeed) this.makeDirDist(DXstart, DYstart);
      this.flush(false);
      this.write(ch('N'));
      this.write(rasterStep < 0 ? ch('R') : ch('L'));
      this.write(ch('B'));
      this.writeStr('S1E');

      let sign = -1;
      const pad = 2;
      for (const scanRaw of scanline) {
        const scan = scanRaw.map((p) => this.ecoordAdj(p, scale, flipX));
        sign = -sign;
        let lastLoop: number | null = null;
        const y = scan[0][1];
        const dy = y - lasty;
        let xr = sign === 1 ? scan[0][0] : scan[scan.length - 1][0];
        let dxr = xr - lastx;

        if (Math.abs(dy - rasterStep) !== 0 && !rapidFlag) {
          const yoffset = dxr * sign < 0 ? -rasterStep * 3 : -rasterStep;
          if ((dy + yoffset) * (Math.abs(yoffset) / yoffset) < 0) {
            this.flush(false);
            if (!rapidFeed) {
              this.write(ch('N'));
              this.makeDirDist(0, dy + yoffset);
              this.flush(false);
              this.writeStr('SE');
            } else {
              this.rasterRapidMoveSlow(0, dy + yoffset, rasterStep, rapidFeed, feed, board);
            }
            rapidFlag = true;
          } else {
            const adjSteps = Math.trunc(dy / rasterStep);
            for (let stp = 1; stp < adjSteps; stp++) {
              const adjDist = 5;
              this.makeDirDist(sign * adjDist, 0);
              lastx += sign * adjDist;
              sign = -sign;
              xr = sign === 1 ? scan[0][0] : scan[scan.length - 1][0];
              dxr = xr - lastx;
            }
          }
          lasty = y;
        }

        if (dxr * sign <= 0.0) {
          if (rapidFlag === false) {
            this.makeDirDist(-sign * pad, 0);
            this.makeDirDist(dxr, 0);
            this.makeDirDist(sign * pad, 0);
          } else {
            this.makeDirDist(dxr, 0);
          }
          lastx += dxr;
        }
        rapidFlag = false;

        const len = scan.length;
        for (let k = 0; k < len; k++) {
          const j = sign === 1 ? k : len - 1 - k;
          const x = scan[j][0];
          const dx = x - lastx;
          const loop = scan[j][2];
          if (loop === lastLoop) {
            this.makeCutLine(dx, 0, true);
          } else if (dx * sign > 0.0) {
            this.makeDirDist(dx, 0);
          }
          lastx = x;
          lastLoop = loop;
        }
        lasty = y;
      }

      this.makeDirDist(pad, 0);
      lastx += pad;
      if (sign < 0) lasty += rasterStep;
      this.flush(false);

      const dxFinal = startX - lastx;
      let dyFinal = rasterStep < 0 ? startY - lasty + rasterStep : startY - lasty - rasterStep;
      const maxReturnFeed = 50.0;
      let finalFeed = 0;
      if (rapidFeed) finalFeed = rapidFeed;
      else if (feed > maxReturnFeed) finalFeed = maxReturnFeed;

      if (finalFeed) {
        this.changeSpeed(finalFeed, board, false, 0, false);
        dyFinal += Math.abs(rasterStep);
        this.makeDirDist(dxFinal, dyFinal);
      } else {
        this.write(ch('N'));
        this.makeDirDist(dxFinal, dyFinal);
        this.flush(false);
        this.writeStr('SE');
      }
    }
    // Footer
    this.flush(false);
    this.writeStr('FNSE');
  }

  makeEgvRapid(DX: number, DY: number, feed: number, board: BoardName, finish = true) {
    const speed = this.makeSpeed(feed, board, 0);
    if (finish) this.write(ch('I'));
    this.writeStr(speed);
    this.flush(false);
    this.writeStr('NRBS1E');
    this.makeCutLine(DX, DY, false);
    this.flush(false);
    this.write(finish ? ch('F') : ch('@'));
    this.writeStr('NSE');
  }

  private rapidMoveSlow(dx: number, dy: number, rapidFeed: number, feed: number, board: BoardName) {
    if (rapidFeed) {
      this.changeSpeed(rapidFeed, board, false);
      this.makeDirDist(dx, dy);
      this.changeSpeed(feed, board, false);
    } else {
      this.makeDirDist(dx, dy);
    }
  }

  private rasterRapidMoveSlow(DX: number, DY: number, rasterStep: number, rapidFeed: number, feed: number, board: BoardName) {
    const tiny = rasterStep / Math.abs(rasterStep);
    this.changeSpeed(rapidFeed, board, false, 0, false);
    this.makeDirDist(DX, DY - tiny);
    this.flush(false);
    this.changeSpeed(feed, board, false, rasterStep, false);
    this.write(ch('N'));
    this.makeDirDist(0, tiny);
    this.flush(false);
    this.writeStr('SE');
  }

  private rapidMoveFast(dx: number, dy: number) {
    let pad = 3;
    if (pad === -dx) pad += 3;
    this.makeDirDist(-pad, 0);
    this.makeDirDist(0, pad);
    this.flush(false);
    this.write(dx + pad < 0 ? ch('B') : ch('T'));
    this.write(ch('N'));
    this.makeDirDist(dx + pad, dy - pad);
    this.flush(false);
    this.writeStr('SE');
  }

  private changeSpeed(feed: number, board: BoardName, laserOn = false, rasterStep = 0, pad = true) {
    const cspad = 5;
    if (laserOn) this.write(OFF);
    if (pad) this.makeDirDist(-cspad, -cspad);
    this.flush(false);
    this.writeStr('@NSE');
    this.writeStr(this.makeSpeed(feed, board, rasterStep));
    this.writeStr('NRBS1E');
    this.write(ch('U'));
    if (pad) this.makeDirDist(cspad, cspad);
    this.flush(false);
    if (laserOn) this.write(ON);
  }
}

export function makeDistance(distMils: number): number[] {
  if (Math.abs(distMils - pyRound(distMils)) > 0.000001) {
    throw new Error('Distance values should be integer value (inches*1000)');
  }
  const code: number[] = [];
  let d = Math.trunc(distMils);
  const n = Math.floor(distMils / 255);
  for (let i = 0; i < n; i++) {
    code.push(122);
    d -= 255;
  }
  if (d === 0) {
    // nichts
  } else if (d < 26) {
    code.push(96 + d);
  } else if (d < 52) {
    code.push(124, 96 + d - 25);
  } else if (d < 255) {
    const s = String(pyRound(d)).padStart(3, '0');
    code.push(s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2));
  } else {
    throw new Error(`Error in EGV makeDistance(): ${d}`);
  }
  return code;
}

/** Entfernt redundante Richtungs-Codes (wird für Rasterdaten verwendet). */
export function stripRedundantCodes(data: number[]): number[] {
  const E = ch('E');
  const out: number[] = [];
  let modal = -1;
  for (const code of data) {
    if (code === modal && modal !== E) continue;
    if (code === RIGHT || code === LEFT || code === UP || code === DOWN || code === ANGLE || code === E) modal = code;
    out.push(code);
  }
  return out;
}

/** Zusammengesetzter Auftrag aus mehreren Teilen (Raster, Gravur, Schnitt) inkl. Durchgänge. */
export function joinJobParts(parts: { data: number[]; passes: number }[]): number[] {
  const data: number[] = [ch('I')];
  for (const p of parts) {
    if (p.data.length === 0) continue;
    for (let k = 0; k < p.passes; k++) {
      if (data.length > 4) data[data.length - 4] = ch('@');
      for (const c of p.data) data.push(c);
    }
  }
  if (data.length < 4) throw new Error('Es wurden keine Laserdaten erzeugt.');
  return data;
}

/** Speichern als .EGV-Datei (kompatibel zu K40 Whisperer / LaserDRW). */
export function egvFileContent(data: number[]): string {
  let s = 'Document type : LHYMICRO-GL file\nCreator-Software: K40 Web\n\n%0%0%0%0%';
  for (const c of data) s += String.fromCharCode(c);
  return s;
}
