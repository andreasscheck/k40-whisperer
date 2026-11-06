/**
 * WebUSB-Treiber für den K40-Controller (M2-Nano u.ä., USB-ID 1a86:5512, CH341 im EPP-Modus).
 * Ersetzt pyusb/libusb aus K40 Whisperer – funktioniert direkt in Chrome/Edge, ohne Treiberinstallation.
 */
import { ESTOP_PACKET, HELLO, HOME_PACKET, UNLOCK_PACKET, makePackets } from './packets';

export const VENDOR_ID = 0x1a86;
export const PRODUCT_ID = 0x5512;

export const STATUS = {
  OK: 206,
  BUFFER_FULL: 238,
  CRC_ERROR: 207,
  TASK_COMPLETE: 236,
  UNKNOWN_2: 239,
  TASK_COMPLETE_M3: 204,
} as const;

const EP_OUT = 2; // 0x02
const EP_IN = 2; // 0x82
const READ_LEN = 168;

export class AbortedError extends Error {
  constructor() {
    super('Vorgang vom Benutzer abgebrochen.');
  }
}

export interface SendOptions {
  onProgress?: (fraction: number, message: string) => void;
  onWarning?: (message: string) => void;
  /** wird vor jedem Paket geprüft; true => Not-Halt und Abbruch */
  shouldAbort?: () => boolean;
  waitForLaser?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class K40Usb {
  timeoutMs = 200;
  maxRetries = 30;
  private pendingRead: Promise<USBInTransferResult> | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(readonly device: USBDevice) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  /** Öffnet den Geräteauswahl-Dialog des Browsers. */
  static async request(): Promise<K40Usb> {
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    const k = new K40Usb(device);
    await k.open();
    return k;
  }

  /** Bereits freigegebenes Gerät ohne Dialog wieder verbinden. */
  static async reconnect(): Promise<K40Usb | null> {
    const devices = await navigator.usb.getDevices();
    const device = devices.find((d) => K40Usb.matches(d));
    return device ? K40Usb.fromDevice(device) : null;
  }

  static matches(d: USBDevice): boolean {
    return d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;
  }

  /** Gerät aus einem USB-"connect"-Ereignis öffnen (nur bereits freigegebene Geräte lösen es aus). */
  static async fromDevice(device: USBDevice): Promise<K40Usb> {
    const k = new K40Usb(device);
    await k.open();
    return k;
  }

  private async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    await d.claimInterface(0);
    // wie im Original: dev.ctrl_transfer(0x40, 177, 0x0102, 0, 0)
    await d.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 177, value: 0x0102, index: 0 });
  }

  async close() {
    try {
      await this.device.releaseInterface(0);
    } catch {
      /* egal */
    }
    try {
      await this.device.close();
    } catch {
      /* egal */
    }
  }

  /** Serialisiert alle USB-Zugriffe (Pause/Not-Halt dürfen sich nicht mit Datenpaketen überschneiden). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async write(packet: Uint8Array) {
    const res = await withTimeout(this.device.transferOut(EP_OUT, packet as BufferSource), this.timeoutMs * 5);
    if (!res || res.status !== 'ok') throw new Error('USB-Schreibfehler');
  }

  /**
   * Liest eine Statusantwort. WebUSB kennt keine Timeouts – eine noch laufende Leseanforderung
   * wird deshalb beim nächsten Mal weiterverwendet, statt eine zweite zu starten.
   */
  private async read(): Promise<Uint8Array | null> {
    if (!this.pendingRead) this.pendingRead = this.device.transferIn(EP_IN, READ_LEN);
    let res: USBInTransferResult | null;
    try {
      res = await withTimeout(this.pendingRead, this.timeoutMs);
    } catch {
      this.pendingRead = null;
      await this.device.clearHalt('in', EP_IN).catch(() => undefined);
      return null;
    }
    if (res === null) return null;
    this.pendingRead = null;
    if (res.status !== 'ok' || !res.data) return null;
    return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  }

  /** "Hello" senden und Statusbyte lesen (null = keine Antwort). */
  private async sayHello(): Promise<number | null> {
    let sent = false;
    for (let i = 0; i < 10 && !sent; i++) {
      try {
        await this.write(HELLO);
        sent = true;
      } catch {
        /* nochmal */
      }
    }
    if (!sent) return null;
    for (let i = 0; i < 10; i++) {
      const r = await this.read();
      if (r && r.length > 1) {
        const s = r[1];
        return (Object.values(STATUS) as number[]).includes(s) ? s : 9999;
      }
    }
    return null;
  }

  status(): Promise<number | null> {
    return this.exclusive(() => this.sayHello());
  }

  home() {
    return this.exclusive(() => this.write(HOME_PACKET));
  }
  unlockRail() {
    return this.exclusive(() => this.write(UNLOCK_PACKET));
  }
  emergencyStop() {
    return this.exclusive(() => this.write(ESTOP_PACKET));
  }
  /** Pause umschalten ("PN"): einmal = Pause, nochmal = weiter. */
  togglePause() {
    return this.exclusive(async () => {
      await this.write(makePackets([80, 78])[0]);
      await this.sayHello();
    });
  }

  /** Wartet, solange der Puffer des Controllers voll ist – ohne die USB-Sperre zu halten (sonst blockiert Pause/Weiter). */
  private async waitForBuffer(opts: SendOptions) {
    for (;;) {
      if (opts.shouldAbort?.()) throw new AbortedError();
      const r = await this.status();
      if (r !== STATUS.BUFFER_FULL) return;
      await sleep(10);
    }
  }

  /** Ein Paket senden und per Statusabfrage prüfen; bei CRC-Fehler/Timeout wiederholen. */
  private async sendPacketChecked(packet: Uint8Array, opts: SendOptions) {
    let timeouts = 1;
    let crcErrors = 1;
    for (;;) {
      await this.waitForBuffer(opts);
      const result = await this.exclusive(async () => {
        try {
          await this.write(packet);
        } catch {
          return 'timeout' as const;
        }
        return (await this.sayHello()) === STATUS.CRC_ERROR ? ('crc' as const) : ('ok' as const);
      });
      if (result === 'ok') return; // OK oder keine Antwort (wie im Original: weitermachen)
      if (result === 'timeout') {
        timeouts++;
        if (timeouts >= this.maxRetries) throw new Error(`Der Laser antwortet nicht (${timeouts} Versuche).`);
        opts.onWarning?.(`USB-Timeout #${timeouts}`);
      } else {
        crcErrors++;
        if (crcErrors >= this.maxRetries) throw new Error(`Zu viele Übertragungsfehler (${crcErrors}).`);
        opts.onWarning?.(`Übertragungsfehler (CRC) #${crcErrors}`);
      }
    }
  }

  /** Sendet einen kompletten EGV-Datenstrom an den Laser. */
  async sendData(data: ArrayLike<number>, opts: SendOptions = {}) {
    const packets = makePackets(data);
    const abortWithStop = async () => {
      await this.emergencyStop().catch(() => undefined);
      throw new AbortedError();
    };
    for (let i = 0; i < packets.length; i++) {
      if (opts.shouldAbort?.()) return abortWithStop();
      try {
        await this.sendPacketChecked(packets[i], opts);
      } catch (e) {
        if (e instanceof AbortedError) return abortWithStop();
        throw e;
      }
      opts.onProgress?.((i + 1) / packets.length, `Sende Daten an Laser: ${(((i + 1) / packets.length) * 100).toFixed(1)} %`);
    }
    if (opts.waitForLaser) {
      opts.onProgress?.(1, 'Warte, bis der Laser fertig ist …');
      for (;;) {
        if (opts.shouldAbort?.()) return abortWithStop();
        const r = await this.status();
        if (r === STATUS.TASK_COMPLETE || r === STATUS.TASK_COMPLETE_M3) break;
        if (r === null) {
          opts.onWarning?.('Laser antwortet nach Abschluss nicht mehr.');
          break;
        }
        await sleep(200);
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
