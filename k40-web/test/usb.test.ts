import { describe, expect, it } from 'vitest';
import { K40Usb, AbortedError, STATUS } from '../src/usb/k40usb';
import { ESTOP_PACKET, makePackets } from '../src/usb/packets';

/** Simuliertes M2-Nano-Board: protokolliert Pakete, liefert Statusantworten nach Skript. */
class FakeDevice {
  opened = false;
  configuration: unknown = null;
  received: number[][] = [];
  control: unknown[] = [];
  /** Statusfolge für Hello-Antworten; danach OK */
  script: (number | 'silent')[] = [];
  /** Nach dem n-ten Datenpaket einmal CRC-Fehler melden */
  crcOnPacket = -1;
  private lastWasData = false;
  private dataCount = 0;
  private pendingStatus: number | null = null;

  async open() { this.opened = true; }
  async selectConfiguration() { this.configuration = {}; }
  async claimInterface() {}
  async releaseInterface() {}
  async close() {}
  async clearHalt() {}
  async controlTransferOut(setup: unknown) { this.control.push(setup); return { status: 'ok' }; }
  async transferOut(_ep: number, data: Uint8Array) {
    const arr = [...data];
    if (arr.length === 1 && arr[0] === 160) {
      // Hello: Status bestimmen
      let s: number | 'silent' = STATUS.OK;
      if (this.lastWasData && this.dataCount - 1 === this.crcOnPacket) {
        s = STATUS.CRC_ERROR;
        this.crcOnPacket = -1;
      } else if (this.script.length) s = this.script.shift()!;
      this.lastWasData = false;
      this.pendingStatus = s === 'silent' ? null : s;
    } else {
      this.received.push(arr);
      this.lastWasData = true;
      this.dataCount++;
    }
    return { status: 'ok', bytesWritten: arr.length };
  }
  transferIn(): Promise<{ status: string; data?: DataView }> {
    const s = this.pendingStatus;
    this.pendingStatus = null;
    if (s === null) return new Promise(() => {}); // keine Antwort -> Timeout
    return Promise.resolve({ status: 'ok', data: new DataView(new Uint8Array([255, s, 0, 0, 0, 0]).buffer) });
  }
}

async function make(dev: FakeDevice) {
  const k = new (K40Usb as any)(dev) as K40Usb;
  await (k as any).open();
  k.timeoutMs = 20;
  return k;
}

const data = Array.from({ length: 200 }, (_, i) => 65 + (i % 26));

describe('USB-Treiber (simuliertes Gerät)', () => {
  it('Initialisierung wie im Original (Vendor-Request 177, 0x0102)', async () => {
    const dev = new FakeDevice();
    await make(dev);
    expect(dev.control).toEqual([{ requestType: 'vendor', recipient: 'device', request: 177, value: 0x0102, index: 0 }]);
  });

  it('sendet alle Pakete in Reihenfolge, wartet bei vollem Puffer, wiederholt bei CRC-Fehler', async () => {
    const dev = new FakeDevice();
    dev.script = [STATUS.BUFFER_FULL, STATUS.BUFFER_FULL, STATUS.BUFFER_FULL];
    dev.crcOnPacket = 3;
    const k = await make(dev);
    const warnings: string[] = [];
    let last = 0;
    await k.sendData(data, { onWarning: (w) => warnings.push(w), onProgress: (f) => (last = f) });
    const expected = makePackets(data).map((p) => [...p]);
    // Paket 3 wurde wegen CRC-Fehler doppelt gesendet
    const withRetry = [...expected.slice(0, 4), expected[3], ...expected.slice(4)];
    expect(dev.received).toEqual(withRetry);
    expect(warnings.some((w) => w.includes('CRC'))).toBe(true);
    expect(last).toBe(1);
  });

  it('läuft weiter, wenn der Controller keinen Status meldet (wie Original)', async () => {
    const dev = new FakeDevice();
    dev.script = ['silent', 'silent', 'silent'];
    const k = await make(dev);
    await k.sendData(data.slice(0, 40));
    expect(dev.received.length).toBe(2);
  });

  it('Abbruch sendet Not-Halt', async () => {
    const dev = new FakeDevice();
    const k = await make(dev);
    let n = 0;
    await expect(k.sendData(data, { shouldAbort: () => ++n > 3 })).rejects.toBeInstanceOf(AbortedError);
    expect(dev.received.at(-1)).toEqual([...ESTOP_PACKET]);
  });

  it('Pause kommt auch durch, während der Puffer voll ist', async () => {
    const dev = new FakeDevice();
    dev.script = Array(50).fill(STATUS.BUFFER_FULL);
    const k = await make(dev);
    let abort = false;
    const job = k.sendData(data, { shouldAbort: () => abort });
    await new Promise((r) => setTimeout(r, 30));
    await k.togglePause(); // darf nicht hängen
    expect(dev.received.some((p) => p[2] === 80 && p[3] === 78)).toBe(true);
    abort = true;
    await expect(job).rejects.toBeInstanceOf(AbortedError);
  });

  it('Warten auf Auftragsende', async () => {
    const dev = new FakeDevice();
    const k = await make(dev);
    const p = k.sendData(data.slice(0, 10), { waitForLaser: true });
    // nach dem Paket: OK, OK, dann fertig
    dev.script = [STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK, STATUS.TASK_COMPLETE];
    await p;
    expect(dev.script.length).toBe(0);
  });
});
