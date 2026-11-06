/**
 * Umrechnung Geschwindigkeit (mm/s) <-> Speed-Code der LHYMICRO-GL-Controller (M2-Nano u.a.).
 * Portiert aus LaserSpeed.py (MIT-Lizenz, MeerK40t / K40 Whisperer).
 */
import { pyRound } from './pyround';

export type BoardName = 'M2' | 'M1' | 'M' | 'B2' | 'B1' | 'B' | 'A';
export const BOARDS: BoardName[] = ['M2', 'M1', 'M', 'B2', 'B1', 'B', 'A'];

const pad3 = (n: number) => {
  const s = String(Math.trunc(n));
  return s.length >= 3 ? s : '0'.repeat(3 - s.length) + s;
};

export function encodeValue(value: number): string {
  const v = Math.trunc(value);
  const b0 = v & 255;
  const b1 = (v >> 8) & 0xffffff;
  return pad3(b1) + pad3(b0);
}

function gearForSpeed(mmPerSecond: number, usesRasterStep: boolean): number {
  if (mmPerSecond <= 25.4) return 1;
  if (mmPerSecond > 25.4 && mmPerSecond <= 60) return 2;
  if (!usesRasterStep) {
    if (mmPerSecond > 60 && mmPerSecond < 127) return 3;
    return 4;
  }
  if (mmPerSecond > 60 && mmPerSecond < 127) return 2;
  if (mmPerSecond >= 127 && mmPerSecond <= 320) return 3;
  return 4;
}

function gearing(board: BoardName, mmPerSecond: number, usesRasterStep: boolean): [number, number, number] {
  const gear = gearForSpeed(mmPerSecond, usesRasterStep);
  let bValues = [64752.0, 64752.0, 64640.0, 64512.0];
  let m = -2000.0;
  if (board[0] === 'M') {
    bValues = [60416.0, 60416.0, 59904.0, 59392.0];
    m = -12120.0;
  }
  if (board === 'B2') m = -24240.0;
  if (board === 'B2') {
    if (mmPerSecond < 7) return [bValues[0], m / 12, usesRasterStep ? 1 : 0];
  } else if (board === 'M') {
    if (mmPerSecond < 6) return [bValues[0], m, 0];
  } else if (board === 'M1') {
    if (mmPerSecond < 6 || (!usesRasterStep && mmPerSecond < 7)) return [bValues[0], m, 0];
  } else if (board === 'M2') {
    if (mmPerSecond < 7) return [65528.0, m / 12, 0];
  }
  return [bValues[gear - 1], m, gear];
}

function valueFromSpeed(mmPerSecond: number, b: number, m: number): number {
  if (mmPerSecond === 0) return b;
  const periodMs = 1 / (mmPerSecond / 25.4);
  return m * periodMs + b;
}

/** Speed-Code wie "CV2251891000127198" oder (Raster) "V2251891G002". */
export function speedCode(mmPerSecondIn: number, rasterStep = 0, board: BoardName = 'M2', dRatio = 0.261199033289): string {
  let mmPerSecond = mmPerSecondIn;
  if (mmPerSecond > 240 && rasterStep === 0) mmPerSecond = 19.05;
  const [b, m, g] = gearing(board, mmPerSecond, rasterStep !== 0);
  let gear = g;
  let speedValue = valueFromSpeed(mmPerSecond, b, m);
  if (speedValue - pyRound(speedValue) > 0.005) speedValue = Math.ceil(speedValue);
  speedValue = pyRound(speedValue);
  const encoded = encodeValue(speedValue);

  if (rasterStep !== 0) {
    if (gear === 0) gear = 1;
    return `V${encoded}${gear}G${pad3(rasterStep)}`;
  }
  if (dRatio === 0 || board === 'A' || board === 'B' || board === 'M') {
    return gear === 0 ? `CV${encoded}1C` : `CV${encoded}${gear}`;
  }
  const stepValue = Math.min(Math.floor(mmPerSecond) + 1, 128);
  const freq = mmPerSecond / 25.4;
  const period = freq === 0 ? 0 : 1 / freq;
  const dValue = (dRatio * -m * period) / stepValue;
  const encDiag = encodeValue(dValue);
  return gear === 0 ? `CV${encoded}1${pad3(stepValue)}${encDiag}C` : `CV${encoded}${gear}${pad3(stepValue)}${encDiag}`;
}

/** Rückrechnung für die Pfad-Simulation (nur Schätzung der Laufzeit). */
export function speedFromCode(code: string, board: BoardName = 'M2'): number {
  let c = code;
  if (c[0] === 'C') c = c.slice(1);
  if (c.endsWith('C')) c = c.slice(0, -1);
  const v = c.slice(1, 7);
  const value = parseInt(v.slice(0, 3), 10) * 256 + parseInt(v.slice(3), 10);
  const gear = parseInt(c[7] ?? '1', 10);
  const raster = c.includes('G');
  let bValues = [64752.0, 64752.0, 64640.0, 64512.0];
  let m = -2000.0;
  if (board[0] === 'M') {
    bValues = [60416.0, 60416.0, 59904.0, 59392.0];
    m = -12120.0;
  }
  if (board === 'B2') m = -24240.0;
  const candidates: [number, number][] = [[bValues[Math.max(gear, 1) - 1], m]];
  if (board === 'M2') candidates.push([65528.0, m / 12]);
  if (board === 'B2') candidates.push([bValues[0], m / 12]);
  if (board === 'M' || board === 'M1') candidates.push([bValues[0], m]);
  // passende Variante wählen: die, deren Rücktransformation wieder denselben Code ergibt
  for (const [b, mm] of candidates) {
    const period = (value - b) / mm;
    if (period <= 0) continue;
    const speed = 25.4 / period;
    const back = speedCode(speed, raster ? 1 : 0, board);
    if (back.includes(v)) return speed;
  }
  const [b, mm] = candidates[0];
  const period = (value - b) / mm;
  return period > 0 ? 25.4 / period : 0;
}
