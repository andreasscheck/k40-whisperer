/**
 * Paketierung der EGV-Daten für den M2-Nano (CH341-Brücke):
 * 34 Byte pro Paket: [166, 0, 30 Byte Nutzdaten (aufgefüllt mit 'F'), 166, CRC]
 * Portiert aus nano_library.py (K40 Whisperer).
 */

export const PACKET_LEN = 34;
export const PAYLOAD = 30;

/** 1-Wire-CRC (Dallas/Maxim), wie im Original. */
export function oneWireCrc(bytes: ArrayLike<number>, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    let inbyte = bytes[i];
    for (let j = 0; j < 8; j++) {
      const mix = (crc ^ inbyte) & 0x01;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      inbyte >>= 1;
    }
  }
  return crc;
}

function finalize(p: Uint8Array): Uint8Array {
  p[PACKET_LEN - 1] = oneWireCrc(p, 1, PACKET_LEN - 2);
  return p;
}

function blank(): Uint8Array {
  const p = new Uint8Array(PACKET_LEN).fill(70);
  p[0] = 166;
  p[1] = 0;
  p[PACKET_LEN - 2] = 166;
  return finalize(p);
}

/** Feste Steuerpakete */
function command(text: string): Uint8Array {
  const p = blank();
  for (let i = 0; i < text.length; i++) p[2 + i] = text.charCodeAt(i);
  return finalize(p);
}
export const HOME_PACKET = command('IPP');
export const UNLOCK_PACKET = command('IS2P');
export const ESTOP_PACKET = command('I');
export const HELLO = new Uint8Array([160]);

export function makePackets(data: ArrayLike<number>): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let packet = blank();
  let cnt = 2;
  for (let i = 0; i < data.length; i++) {
    if (cnt > PAYLOAD + 1) {
      packets.push(finalize(packet));
      packet = blank();
      cnt = 2;
    }
    packet[cnt++] = data[i];
  }
  packets.push(finalize(packet));
  if (cnt > PAYLOAD + 1) packets.push(blank()); // Eigenheit des Originals beibehalten
  return packets;
}
