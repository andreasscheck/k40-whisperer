/**
 * Interpreter für EGV-Daten: rekonstruiert den Weg des Laserkopfs (für Vorschau,
 * Laufzeitschätzung und Tests). Einheit: Tausendstel Zoll, y nach OBEN.
 *
 * Hinweis: Der automatische Zeilenvorschub im Rastermodus wird angenähert (Vorschub bei jedem
 * Richtungswechsel in X). Bei 1-mil-Rasterschritten mit übersprungenen Leerzeilen kann die
 * Vorschau dadurch um wenige Zeilen von der Realität abweichen – die gesendeten Daten nicht.
 */
import { speedFromCode, type BoardName } from './laserSpeed';

export interface SimSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  laser: boolean;
  /** true = schneller Eilgang ("N … SE"-Block) */
  rapid: boolean;
  speed: number; // mm/s
}

export interface SimResult {
  segments: SimSegment[];
  endX: number;
  endY: number;
  /** geschätzte Laufzeit in Sekunden */
  seconds: number;
}

const isDigit = (c: number) => c >= 48 && c <= 57;
const isLower = (c: number) => c >= 97 && c <= 122;

export function simulateEgv(data: ArrayLike<number>, board: BoardName = 'M2', rapidSpeed = 100): SimResult {
  const segments: SimSegment[] = [];
  let x = 0;
  let y = 0;
  let dirX = 1;
  let dirY = 1;
  let laser = false;
  let compact = false;
  let rasterStep = 0;
  let speed = 10;
  let lastDir = '';
  let seconds = 0;
  let i = 0;
  const n = data.length;

  const add = (dx: number, dy: number, burn = true) => {
    if (dx === 0 && dy === 0) return;
    const rapid = !compact;
    const seg: SimSegment = { x0: x, y0: y, x1: x + dx, y1: y + dy, laser: burn && laser && compact, rapid, speed };
    x += dx;
    y += dy;
    segments.push(seg);
    const lenMm = (Math.hypot(dx, dy) * 25.4) / 1000;
    seconds += lenMm / (rapid ? rapidSpeed : Math.max(speed, 0.1));
  };

  const readDistance = (): number | null => {
    let d = 0;
    let any = false;
    while (i < n) {
      const c = data[i];
      if (c === 122) {
        d += 255;
        i++;
        any = true;
      } else if (c === 124 && i + 1 < n && isLower(data[i + 1])) {
        d += data[i + 1] - 96 + 25;
        i += 2;
        return d;
      } else if (isLower(c)) {
        d += c - 96;
        i++;
        return d;
      } else if (isDigit(c) && i + 2 < n && isDigit(data[i + 1]) && isDigit(data[i + 2])) {
        d += (c - 48) * 100 + (data[i + 1] - 48) * 10 + (data[i + 2] - 48);
        i += 3;
        return d;
      } else break;
    }
    return any ? d : null;
  };

  while (i < n) {
    const c = String.fromCharCode(data[i]);
    switch (c) {
      case 'I':
      case 'P':
        i++;
        break;
      case 'C':
      case 'V': {
        // Speed-Code: C?V<Ziffern>[G<3 Ziffern>][C]
        const start = i;
        if (c === 'C') i++;
        if (String.fromCharCode(data[i]) !== 'V') {
          i = start + 1;
          break;
        }
        i++;
        while (i < n && isDigit(data[i])) i++;
        let step = 0;
        if (i < n && data[i] === 71 /* G */) {
          i++;
          const s = i;
          while (i < n && isDigit(data[i]) && i - s < 3) i++;
          step = parseInt(String.fromCharCode(...Array.from({ length: i - s }, (_, k) => data[s + k])), 10);
        }
        if (i < n && data[i] === 67 /* C */) i++;
        let code = '';
        for (let k = start; k < i; k++) code += String.fromCharCode(data[k]);
        speed = speedFromCode(code, board);
        rasterStep = step;
        break;
      }
      case 'N':
        compact = false;
        i++;
        break;
      case 'S': {
        i++;
        if (data[i] === 49 /* 1 */) i++;
        if (data[i] === 69 /* E */) {
          compact = true;
          i++;
        } else if (data[i] === 80 /* P */) {
          i++;
        }
        break;
      }
      case '@':
      case 'F':
        i++;
        break;
      case 'D':
        laser = true;
        i++;
        break;
      case 'U':
        laser = false;
        i++;
        break;
      case 'B':
      case 'T': {
        i++;
        const nd = c === 'B' ? 1 : -1;
        if (compact && rasterStep && nd !== dirX) add(0, dirY * rasterStep, false); // Zeilenvorschub im Rastermodus
        dirX = nd;
        lastDir = c;
        const d = readDistance();
        if (d !== null) add(dirX * d, 0);
        break;
      }
      case 'L':
      case 'R': {
        i++;
        dirY = c === 'L' ? 1 : -1;
        lastDir = c;
        const d = readDistance();
        if (d !== null) add(0, dirY * d);
        break;
      }
      case 'M': {
        i++;
        lastDir = c;
        const d = readDistance();
        if (d !== null) add(dirX * d, dirY * d);
        break;
      }
      case 'E':
        i++;
        break;
      default: {
        // Distanz ohne Richtungsbuchstaben (nach strip_redundant_codes): gilt in der letzten Richtung
        const d = lastDir ? readDistance() : null;
        if (d === null) {
          i++;
          break;
        }
        if (lastDir === 'B' || lastDir === 'T') add(dirX * d, 0);
        else if (lastDir === 'L' || lastDir === 'R') add(0, dirY * d);
        else add(dirX * d, dirY * d);
      }
    }
  }
  return { segments, endX: x, endY: y, seconds };
}
