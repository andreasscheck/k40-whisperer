/**
 * Python-3-kompatibles round() (Banker's Rounding: .5 wird zur geraden Zahl gerundet).
 * Wird verwendet, damit die erzeugten EGV-Daten Byte für Byte mit K40 Whisperer übereinstimmen.
 */
export function pyRound(x: number): number {
  const frac = x - Math.trunc(x);
  if (Math.abs(frac) === 0.5) return 2 * Math.round(x / 2);
  const r = Math.round(x);
  return r === 0 ? 0 : r; // kein -0
}
