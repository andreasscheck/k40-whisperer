import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ESTOP_PACKET, HOME_PACKET, UNLOCK_PACKET, makePackets } from '../src/usb/packets';

describe('USB-Pakete', () => {
  it('feste Steuerpakete entsprechen dem Original', () => {
    expect([...HOME_PACKET]).toEqual([166, 0, 73, 80, 80, ...Array(27).fill(70), 166, 228]);
    expect([...UNLOCK_PACKET]).toEqual([166, 0, 73, 83, 50, 80, ...Array(26).fill(70), 166, 15]);
    expect([...ESTOP_PACKET]).toEqual([166, 0, 73, ...Array(29).fill(70), 166, 130]);
    expect([...makePackets([70])[0]].at(-1)).toBe(80); // leeres Paket, CRC 80 wie im Original
  });

  it('Paketierung + CRC identisch zu nano_library.py', () => {
    const cases = JSON.parse(readFileSync(new URL('./golden/packets.json', import.meta.url), 'utf8'));
    for (const c of cases) {
      expect(makePackets(c.data).map((p) => [...p]), `n=${c.data.length}`).toEqual(c.packets);
    }
  });
});
