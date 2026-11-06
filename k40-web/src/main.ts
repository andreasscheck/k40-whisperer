import { EgvWriter, egvFileContent } from './core/egv';
import { simulateEgv, type SimResult } from './core/egvSim';
import { DEFAULT_JOB, buildJob, grayToBits, type GrayRaster, type JobOps, type RasterBits } from './core/job';
import type { BoardName } from './core/laserSpeed';
import { loadImage, loadSvg, renderRaster, type Design } from './io/design';
import { AbortedError, K40Usb, STATUS } from './usb/k40usb';

// ------------------------------------------------------------------ Einstellungen

const DEFAULTS = {
  ...DEFAULT_JOB,
  bedW: 325,
  bedH: 220,
  jogStep: 10,
  rasterMode: 'threshold' as 'threshold' | 'dither',
  threshold: 128,
  gamma: 1,
  invert: false,
  mirror: false,
  rotate: false,
  imageDpi: 300,
  waitFinish: true,
  timeoutMs: 200,
  showSim: false,
};
type Settings = typeof DEFAULTS;
const KEY = 'k40web.settings.v1';

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
const S: Settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch {
    /* privates Fenster o.ä. */
  }
}

// ------------------------------------------------------------------ Zustand

const MIL_PER_MM = 1000 / 25.4;
let design: Design | null = null;
let sourceFile: File | null = null;
let laser: K40Usb | null = null;
/** obere linke Ecke des Designs auf dem Arbeitsbereich (1/1000 Zoll, y nach unten) */
const anchor = { x: 0, y: 0 };
/** aktuelle Kopfposition (1/1000 Zoll, y nach unten) */
const head = { x: 0, y: 0 };
let homed = false;
/** Antwortet der Controller auf Statusabfragen? null = unbekannt */
let responsive: boolean | null = null;
let polling = false;
let autoConnecting = false;
let busy = false;
let abortRequested = false;
let paused = false;
let grayCache: { key: string; gray: GrayRaster } | null = null;
let bitsCache: { key: string; bits: RasterBits } | null = null;
let simCache: { key: string; sim: SimResult } | null = null;
let motion: Promise<unknown> = Promise.resolve();

// ------------------------------------------------------------------ DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const stage = $('stage');

function setStatus(text: string, kind: '' | 'error' | 'warn' | 'busy' = '') {
  $('statusText').textContent = text;
  $('statusText').title = text;
  $('statusBar').className = 'status' + (kind ? ' ' + kind : '');
}
function setProgress(f: number | null) {
  $('progress').style.width = f === null ? '0' : `${Math.round(f * 100)}%`;
}
const fmtMm = (mils: number) => ((mils / MIL_PER_MM).toFixed(1) as string).replace('.', ',');
const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.round(s - m * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(ss).padStart(2, '0')} min`;
};

// ------------------------------------------------------------------ Einstellungen <-> Formular

const numFields: (keyof Settings)[] = ['rasterFeed', 'rasterPasses', 'engraveFeed', 'engravePasses', 'cutFeed', 'cutPasses', 'bedW', 'bedH', 'jogStep', 'gamma', 'imageDpi', 'scaleX', 'scaleY', 'timeoutMs', 'threshold'];
const boolFields: (keyof Settings)[] = ['invert', 'rasterBottomUp', 'mirror', 'rotate', 'insideFirst', 'waitFinish', 'showSim'];
const idOf: Partial<Record<keyof Settings, string>> = { rasterBottomUp: 'bottomUp' };
const reloadOn = new Set<keyof Settings>(['mirror', 'rotate', 'imageDpi']);

function bindSettings() {
  for (const k of numFields) {
    const el = $<HTMLInputElement>(idOf[k] ?? k);
    el.value = String(S[k]);
    el.addEventListener('change', () => {
      const v = parseFloat(el.value.replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0) {
        el.value = String(S[k]);
        return;
      }
      (S as any)[k] = ['rasterPasses', 'engravePasses', 'cutPasses'].includes(k) ? Math.max(1, Math.round(v)) : v;
      el.value = String(S[k]);
      onSettingsChanged(k);
    });
  }
  for (const k of boolFields) {
    const el = $<HTMLInputElement>(idOf[k] ?? k);
    el.checked = Boolean(S[k]);
    el.addEventListener('change', () => {
      (S as any)[k] = el.checked;
      onSettingsChanged(k);
    });
  }
  const sel = (id: string, k: keyof Settings, conv: (v: string) => unknown) => {
    const el = $<HTMLSelectElement>(id);
    el.value = String(S[k]);
    el.addEventListener('change', () => {
      (S as any)[k] = conv(el.value);
      onSettingsChanged(k);
    });
  };
  sel('board', 'board', (v) => v as BoardName);
  sel('rasterStep', 'rasterStepMils', (v) => parseInt(v, 10));
  sel('rasterMode', 'rasterMode', (v) => v);
}

function onSettingsChanged(k: keyof Settings) {
  saveSettings();
  simCache = null;
  if (k === 'timeoutMs' && laser) laser.timeoutMs = S.timeoutMs;
  if (reloadOn.has(k) && sourceFile) {
    void openFile(sourceFile);
    return;
  }
  if (k === 'bedW' || k === 'bedH') clampAnchor();
  updateInfo();
  draw();
  if (S.showSim) void refreshSim();
}

// ------------------------------------------------------------------ Datei laden

async function openFile(file: File) {
  if (busy) return;
  sourceFile = file;
  setStatus(`Lade ${file.name} …`, 'busy');
  try {
    const opts = { mirror: S.mirror, rotate: S.rotate, imageDpi: S.imageDpi };
    const isSvg = file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml';
    design = isSvg ? await loadSvg(file.name, await file.text(), opts) : await loadImage(file.name, file, opts);
    grayCache = bitsCache = simCache = null;
    $<HTMLInputElement>('opRaster').checked = design.hasRaster;
    $<HTMLInputElement>('opEngrave').checked = design.engrave.length > 0;
    $<HTMLInputElement>('opCut').checked = design.cut.length > 0;
    $('fileName').textContent = `${file.name} – ${design.widthMm.toFixed(1)} × ${design.heightMm.toFixed(1)} mm`;
    clampAnchor();
    showWarnings(design.warnings);
    setStatus(`${file.name} geladen.`);
  } catch (e) {
    design = null;
    showWarnings([]);
    setStatus(`Datei konnte nicht geladen werden: ${(e as Error).message}`, 'error');
  }
  updateInfo();
  updateButtons();
  draw();
  if (S.showSim) void refreshSim();
}

function showWarnings(w: string[]) {
  const el = $('warnings');
  el.hidden = w.length === 0;
  el.replaceChildren(
    ...w.map((t) => {
      const d = document.createElement('div');
      d.textContent = '⚠ ' + t;
      return d;
    }),
  );
}

function pathLength(polys: [number, number][][]): number {
  let l = 0;
  for (const p of polys) for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

function updateInfo() {
  $('infoRaster').textContent = design ? (design.hasRaster ? 'Rasterinhalt vorhanden' : 'kein Rasterinhalt') : '–';
  const v = (polys: [number, number][][] | undefined, what: string) =>
    design && polys?.length ? `${polys.length} ${what}, ${Math.round(pathLength(polys))} mm` : design ? `keine (Kontur ${what === 'Schnitte' ? 'rot' : 'blau'})` : '–';
  $('infoEngrave').textContent = v(design?.engrave, 'Pfade');
  $('infoCut').textContent = v(design?.cut, 'Schnitte');
  const est = simCache ? `Geschätzte Dauer: ${fmtTime(simCache.sim.seconds)}` : '';
  $('estimate').textContent = est;
  $('posText').textContent =
    `Design: X ${fmtMm(anchor.x)} / Y ${fmtMm(anchor.y)} mm · Kopf: ${homed || !laser ? `X ${fmtMm(head.x)} / Y ${fmtMm(head.y)} mm` : 'unbekannt (Home drücken)'}`;
}

function updateButtons() {
  const has = design !== null;
  $<HTMLButtonElement>('btnStart').disabled = busy || !has;
  $<HTMLButtonElement>('btnExport').disabled = busy || !has;
  $<HTMLButtonElement>('btnReload').disabled = busy || !sourceFile;
  $<HTMLButtonElement>('btnStop').disabled = !busy || !laser;
  for (const id of ['btnHome', 'btnUnlock', 'btnStatus']) $<HTMLButtonElement>(id).disabled = busy || !laser;
  document.querySelectorAll<HTMLButtonElement>('[data-jog],[data-corner],#btnGoto,#btnCenterHead').forEach((b) => (b.disabled = busy));
  $('btnConnect').hidden = laser !== null;
  $('btnDisconnect').hidden = laser === null;
  const silent = laser !== null && responsive === false;
  $('connDot').className = 'dot' + (laser ? (busy ? ' busy' : silent ? ' stale' : ' on') : '');
  $('connText').textContent = laser ? (busy ? 'Verbunden – Auftrag läuft' : silent ? 'Verbunden – Laser antwortet nicht' : 'Verbunden') : K40Usb.isSupported() ? 'Nicht verbunden (Simulation)' : 'WebUSB nicht verfügbar – bitte Chrome/Edge verwenden';
  $<HTMLButtonElement>('btnConnect').disabled = !K40Usb.isSupported();
}

// ------------------------------------------------------------------ Position

const designSizeMils = () => (design ? { w: design.widthMm * MIL_PER_MM, h: design.heightMm * MIL_PER_MM } : { w: 0, h: 0 });

function clampAnchor() {
  const { w, h } = designSizeMils();
  const bw = S.bedW * MIL_PER_MM;
  const bh = S.bedH * MIL_PER_MM;
  anchor.x = Math.round(Math.max(0, Math.min(anchor.x, bw - w)));
  anchor.y = Math.round(Math.max(0, Math.min(anchor.y, bh - h)));
}

/** Kopf an Position fahren (Eilgang). Bewegungen werden nacheinander ausgeführt. */
function moveHeadTo(x: number, y: number): Promise<unknown> {
  motion = motion.then(async () => {
    const tx = Math.round(x);
    const ty = Math.round(y);
    const dx = tx - head.x;
    const dy = ty - head.y;
    if (dx === 0 && dy === 0) return;
    if (laser) {
      const w = new EgvWriter();
      w.makeMoveData(Math.round(dx * S.scaleX), -Math.round(dy * S.scaleY));
      try {
        await laser.sendData(w.out);
      } catch (e) {
        setStatus(`Bewegung fehlgeschlagen: ${(e as Error).message}`, 'error');
        throw e;
      }
    }
    head.x = tx;
    head.y = ty;
    updateInfo();
    draw();
  });
  motion = motion.catch(() => undefined);
  return motion;
}

function jog(dxDir: number, dyDir: number) {
  if (busy) return;
  const step = S.jogStep * MIL_PER_MM;
  anchor.x += dxDir * step;
  anchor.y += dyDir * step;
  clampAnchor();
  updateInfo();
  draw();
  void moveHeadTo(anchor.x, anchor.y);
}

function moveToCorner(c: string) {
  if (busy) return;
  const { w, h } = designSizeMils();
  const off = { tl: [0, 0], tr: [w, 0], bl: [0, h], br: [w, h], c: [w / 2, h / 2] }[c] ?? [0, 0];
  void moveHeadTo(anchor.x + off[0], anchor.y + off[1]);
}

// ------------------------------------------------------------------ Laser

async function connect() {
  try {
    const k = await K40Usb.request();
    await attach(k, true);
  } catch (e) {
    if ((e as Error).name === 'NotFoundError') return setStatus('Kein Gerät ausgewählt.');
    setStatus(`Verbindung fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
}

async function attach(k: K40Usb, doHome: boolean) {
  laser = k;
  laser.timeoutMs = S.timeoutMs;
  const st = await laser.status().catch(() => null);
  responsive = st !== null;
  if (st === null) setStatus('Laser verbunden, antwortet aber nicht. Ist er eingeschaltet?', 'warn');
  else setStatus('Laser verbunden.');
  if (doHome) await home();
  updateButtons();
  updateInfo();
}

async function disconnect() {
  if (!laser || busy) return;
  await laser.close();
  laser = null;
  homed = false;
  responsive = null;
  updateButtons();
  updateInfo();
  setStatus('Laser getrennt.');
}

async function home() {
  if (!laser) return;
  await laser.home();
  head.x = head.y = 0;
  homed = true;
  updateInfo();
  draw();
  setStatus('Kopf fährt in die Ausgangsposition (oben links).');
}

async function unlock() {
  if (!laser) return;
  await laser.unlockRail();
  homed = false;
  updateInfo();
  setStatus('Achsen entriegelt – der Kopf kann von Hand verschoben werden. Danach „Home“ drücken.', 'warn');
}

async function queryStatus() {
  if (!laser) return;
  const r = await laser.status().catch(() => null);
  responsive = r !== null;
  updateButtons();
  const names: Record<number, string> = {
    [STATUS.OK]: 'OK',
    [STATUS.BUFFER_FULL]: 'Puffer voll',
    [STATUS.CRC_ERROR]: 'CRC-Fehler',
    [STATUS.TASK_COMPLETE]: 'Auftrag fertig',
    [STATUS.TASK_COMPLETE_M3]: 'Auftrag fertig',
    [STATUS.UNKNOWN_2]: 'bereit (nach Neuinitialisierung)',
  };
  setStatus(r === null ? 'Keine Antwort vom Laser.' : `Laser-Status: ${names[r] ?? 'unbekannt'} (${r})`, r === null ? 'warn' : '');
}

async function pollStatus() {
  if (!laser || busy || polling || drag || document.hidden) return;
  polling = true;
  const k = laser;
  try {
    const r = await k.status().catch(() => null);
    if (laser !== k || busy) return; // inzwischen getrennt oder Auftrag gestartet
    const now = r !== null;
    if (now !== responsive) {
      const before = responsive;
      responsive = now;
      updateButtons();
      if (!now) setStatus('Laser antwortet nicht mehr – ist er eingeschaltet?', 'warn');
      else if (before === false) setStatus('Laser antwortet wieder.');
    }
  } finally {
    polling = false;
  }
}

// ------------------------------------------------------------------ Auftrag

function currentOps(): JobOps {
  return {
    raster: $<HTMLInputElement>('opRaster').checked,
    engrave: $<HTMLInputElement>('opEngrave').checked,
    cut: $<HTMLInputElement>('opCut').checked,
  };
}

async function getRasterBits(onProgress: (f: number) => void): Promise<RasterBits | null> {
  if (!design?.hasRaster) return null;
  const gkey = `${design.name}|${design.widthMm}|${S.rasterStepMils}|${S.scaleX}|${S.scaleY}|${S.mirror}|${S.rotate}|${S.imageDpi}`;
  if (!grayCache || grayCache.key !== gkey) {
    const gray = await renderRaster(design, S.rasterStepMils, S.scaleX, S.scaleY, onProgress);
    grayCache = { key: gkey, gray };
    bitsCache = null;
  }
  const bkey = `${gkey}|${S.rasterMode}|${S.threshold}|${S.gamma}|${S.invert}`;
  if (!bitsCache || bitsCache.key !== bkey) {
    bitsCache = { key: bkey, bits: grayToBits(grayCache.gray, { mode: S.rasterMode, threshold: S.threshold, invert: S.invert, gamma: S.gamma }) };
  }
  return bitsCache.bits;
}

async function makeJobData(ops: JobOps): Promise<number[]> {
  if (!design) throw new Error('Keine Datei geladen.');
  if (!ops.raster && !ops.engrave && !ops.cut) throw new Error('Bitte mindestens einen Vorgang auswählen.');
  let raster: RasterBits | null = null;
  if (ops.raster) {
    raster = await getRasterBits((f) => {
      setStatus(`Raster wird berechnet: ${Math.round(f * 100)} %`, 'busy');
      setProgress(f);
    });
  }
  const data = buildJob({ cut: design.cut, engrave: design.engrave, raster }, ops, S);
  return data;
}

async function startJob() {
  if (!design || busy) return;
  const ops = currentOps();
  busy = true;
  abortRequested = false;
  updateButtons();
  setProgress(0);
  try {
    setStatus('Bereite Auftrag vor …', 'busy');
    const data = await makeJobData(ops);
    const sim = simulateEgv(data, S.board);
    simCache = { key: simKey(ops), sim };
    updateInfo();
    draw();
    if (!laser) {
      setStatus(`Kein Laser verbunden – nur simuliert. Geschätzte Dauer ${fmtTime(sim.seconds)}. Aktiviere „Pfad-Simulation“ für die Vorschau.`, 'warn');
      return;
    }
    await moveHeadTo(anchor.x, anchor.y);
    const t0 = performance.now();
    await laser.sendData(data, {
      shouldAbort: () => abortRequested,
      onProgress: (f, msg) => {
        setProgress(f);
        setStatus(msg, 'busy');
      },
      onWarning: (m) => setStatus(m, 'warn'),
      waitForLaser: S.waitFinish,
    });
    const secs = (performance.now() - t0) / 1000;
    setStatus(`Auftrag abgeschlossen (${fmtTime(secs)}).`);
    notifyDone();
  } catch (e) {
    if (e instanceof AbortedError) {
      homed = false;
      setStatus('Auftrag abgebrochen (Not-Halt gesendet). Bitte „Home“ drücken, bevor du weiterarbeitest.', 'error');
    } else {
      setStatus(`Fehler: ${(e as Error).message}`, 'error');
    }
  } finally {
    busy = false;
    paused = false;
    setProgress(null);
    updateButtons();
    updateInfo();
  }
}

function notifyDone() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch {
    /* kein Ton */
  }
}

async function stopJob() {
  if (!busy || !laser) return;
  if (!paused) {
    paused = true;
    await laser.togglePause().catch(() => undefined);
  }
  const dlg = $<HTMLDialogElement>('dlg');
  $('dlgText').textContent = 'Der Laser ist pausiert. Auftrag abbrechen oder fortsetzen?';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    async () => {
      if (dlg.returnValue === 'ok') {
        abortRequested = true;
        setStatus('Breche ab …', 'error');
      } else {
        paused = false;
        await laser?.togglePause().catch(() => undefined);
        setStatus('Fortgesetzt.', 'busy');
      }
    },
    { once: true },
  );
}

async function exportEgv() {
  if (!design || busy) return;
  busy = true;
  updateButtons();
  try {
    const data = await makeJobData(currentOps());
    const blob = new Blob([egvFileContent(data)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = design.name.replace(/\.[^.]+$/, '') + '.EGV';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus(`EGV-Datei gespeichert (${data.length} Byte).`);
  } catch (e) {
    setStatus(`Export fehlgeschlagen: ${(e as Error).message}`, 'error');
  } finally {
    busy = false;
    setProgress(null);
    updateButtons();
  }
}

function simKey(ops: JobOps) {
  return JSON.stringify([design?.name, design?.widthMm, ops, S]);
}

async function refreshSim() {
  if (!design || !S.showSim) return draw();
  const ops = currentOps();
  const key = simKey(ops);
  if (simCache?.key === key) return draw();
  if (busy) return;
  try {
    if (!ops.raster && !ops.engrave && !ops.cut) {
      simCache = null;
    } else {
      const data = await makeJobData(ops);
      simCache = { key, sim: simulateEgv(data, S.board) };
      setStatus(`Simulation: geschätzte Dauer ${fmtTime(simCache.sim.seconds)}.`);
    }
  } catch (e) {
    setStatus(`Simulation fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
  setProgress(null);
  updateInfo();
  draw();
}

// ------------------------------------------------------------------ Zeichnen

let view = { k: 1, ox: 0, oy: 0 };

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const m = 34;
  const k = Math.min((rect.width - 2 * m) / S.bedW, (rect.height - 2 * m) / S.bedH);
  view = { k, ox: (rect.width - S.bedW * k) / 2, oy: (rect.height - S.bedH * k) / 2 };
  const X = (mm: number) => view.ox + mm * k;
  const Y = (mm: number) => view.oy + mm * k;

  // Arbeitsbereich + Raster
  ctx.fillStyle = css('--bed');
  ctx.fillRect(X(0), Y(0), S.bedW * k, S.bedH * k);
  ctx.lineWidth = 1;
  for (let x = 0; x <= S.bedW; x += 10) {
    ctx.strokeStyle = x % 50 === 0 ? css('--grid-major') : css('--grid');
    ctx.beginPath();
    ctx.moveTo(Math.round(X(x)) + 0.5, Y(0));
    ctx.lineTo(Math.round(X(x)) + 0.5, Y(S.bedH));
    ctx.stroke();
  }
  for (let y = 0; y <= S.bedH; y += 10) {
    ctx.strokeStyle = y % 50 === 0 ? css('--grid-major') : css('--grid');
    ctx.beginPath();
    ctx.moveTo(X(0), Math.round(Y(y)) + 0.5);
    ctx.lineTo(X(S.bedW), Math.round(Y(y)) + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = css('--grid-major');
  ctx.strokeRect(X(0) + 0.5, Y(0) + 0.5, S.bedW * k, S.bedH * k);
  ctx.fillStyle = css('--muted');
  ctx.font = '10px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let x = 0; x <= S.bedW; x += 50) ctx.fillText(String(x), X(x), Y(0) - 6);
  ctx.textAlign = 'right';
  for (let y = 50; y <= S.bedH; y += 50) ctx.fillText(String(y), X(0) - 5, Y(y) + 3);

  // Design
  const ax = anchor.x / MIL_PER_MM;
  const ay = anchor.y / MIL_PER_MM;
  if (design) {
    const showSim = S.showSim && simCache;
    if (design.preview && !showSim) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(design.preview, X(ax), Y(ay), design.widthMm * k, design.heightMm * k);
      ctx.globalAlpha = 1;
    }
    if (!showSim) {
      const drawPolys = (polys: [number, number][][], color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const p of polys) {
          ctx.moveTo(X(ax + p[0][0]), Y(ay + p[0][1]));
          for (let i = 1; i < p.length; i++) ctx.lineTo(X(ax + p[i][0]), Y(ay + p[i][1]));
        }
        ctx.stroke();
      };
      drawPolys(design.engrave, '#2563eb');
      drawPolys(design.cut, '#e11d48');
    } else {
      drawSim(ctx, X, Y, ax, ay);
    }
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = css('--muted');
    ctx.lineWidth = 1;
    ctx.strokeRect(X(ax), Y(ay), design.widthMm * k, design.heightMm * k);
    ctx.setLineDash([]);
  }

  // Laserkopf
  const hx = X(head.x / MIL_PER_MM);
  const hy = Y(head.y / MIL_PER_MM);
  ctx.strokeStyle = homed || !laser ? '#16a34a' : '#f59e0b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(hx, hy, 6, 0, Math.PI * 2);
  ctx.moveTo(hx - 11, hy);
  ctx.lineTo(hx + 11, hy);
  ctx.moveTo(hx, hy - 11);
  ctx.lineTo(hx, hy + 11);
  ctx.stroke();
}

let simLayer: { sim: SimResult; w: number; h: number; canvas: HTMLCanvasElement; vectors: SimResult['segments'] } | null = null;

/** Brennwege in ein Bitmap rastern – Rasteraufträge haben leicht Millionen Segmente. */
function buildSimLayer(sim: SimResult, k: number, dpr: number) {
  const w = Math.max(1, Math.ceil((design!.widthMm + 4) * k * dpr));
  const h = Math.max(1, Math.ceil((design!.heightMm + 4) * k * dpr));
  if (simLayer && simLayer.sim === sim && simLayer.w === w && simLayer.h === h) return simLayer;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  const color = 0xff1673f9; // ABGR: #f97316
  const f = (k * dpr) / MIL_PER_MM;
  const off = 2 * k * dpr; // 2 mm Rand
  const vectors: SimResult['segments'] = [];
  for (const s of sim.segments) {
    if (!s.laser) continue;
    if (s.y0 !== s.y1) {
      vectors.push(s);
      continue;
    }
    const row = Math.floor(off + (-s.y0 / S.scaleY) * f);
    if (row < 0 || row >= h) continue;
    let a = Math.floor(off + (Math.min(s.x0, s.x1) / S.scaleX) * f);
    let b = Math.ceil(off + (Math.max(s.x0, s.x1) / S.scaleX) * f);
    a = Math.max(0, a);
    b = Math.min(w, Math.max(b, a + 1));
    px.fill(color, row * w + a, row * w + b);
  }
  ctx.putImageData(img, 0, 0);
  simLayer = { sim, w, h, canvas: c, vectors };
  return simLayer;
}

function drawSim(ctx: CanvasRenderingContext2D, X: (mm: number) => number, Y: (mm: number) => number, ax: number, ay: number) {
  const sim = simCache!.sim;
  const dpr = window.devicePixelRatio || 1;
  const toX = (mils: number) => X(ax + mils / S.scaleX / MIL_PER_MM);
  const toY = (mils: number) => Y(ay - mils / S.scaleY / MIL_PER_MM);
  const rapids = sim.segments.filter((s) => !s.laser && s.rapid);
  if (rapids.length < 20000) {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(120,130,145,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const s of rapids) {
      ctx.moveTo(toX(s.x0), toY(s.y0));
      ctx.lineTo(toX(s.x1), toY(s.y1));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const layer = buildSimLayer(sim, view.k, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer.canvas, X(ax - 2), Y(ay - 2), layer.w / dpr, layer.h / dpr);
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = Math.max(1, view.k * 0.06);
  ctx.beginPath();
  for (const s of layer.vectors) {
    ctx.moveTo(toX(s.x0), toY(s.y0));
    ctx.lineTo(toX(s.x1), toY(s.y1));
  }
  ctx.stroke();
}

// Design mit der Maus verschieben
let drag: { sx: number; sy: number; ax: number; ay: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!design || busy) return;
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left - view.ox) / view.k;
  const my = (e.clientY - r.top - view.oy) / view.k;
  const ax = anchor.x / MIL_PER_MM;
  const ay = anchor.y / MIL_PER_MM;
  if (mx >= ax && mx <= ax + design.widthMm && my >= ay && my <= ay + design.heightMm) {
    drag = { sx: e.clientX, sy: e.clientY, ax: anchor.x, ay: anchor.y };
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left - view.ox) / view.k;
  const my = (e.clientY - r.top - view.oy) / view.k;
  if (design && !drag) {
    const ax = anchor.x / MIL_PER_MM;
    const ay = anchor.y / MIL_PER_MM;
    canvas.style.cursor = !busy && mx >= ax && mx <= ax + design.widthMm && my >= ay && my <= ay + design.heightMm ? 'grab' : 'default';
  }
  if (!drag) return;
  canvas.style.cursor = 'grabbing';
  anchor.x = drag.ax + ((e.clientX - drag.sx) / view.k) * MIL_PER_MM;
  anchor.y = drag.ay + ((e.clientY - drag.sy) / view.k) * MIL_PER_MM;
  clampAnchor();
  updateInfo();
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  canvas.style.cursor = 'grab';
  void moveHeadTo(anchor.x, anchor.y);
});

// ------------------------------------------------------------------ Verdrahtung

function init() {
  bindSettings();
  $('fileInput').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void openFile(f);
    (e.target as HTMLInputElement).value = '';
  });
  $('btnReload').addEventListener('click', () => sourceFile && void openFile(sourceFile));
  $('btnConnect').addEventListener('click', () => void connect());
  $('btnDisconnect').addEventListener('click', () => void disconnect());
  $('btnHome').addEventListener('click', () => void home());
  $('btnUnlock').addEventListener('click', () => void unlock());
  $('btnStatus').addEventListener('click', () => void queryStatus());
  $('btnStart').addEventListener('click', () => void startJob());
  $('btnStop').addEventListener('click', () => void stopJob());
  $('btnExport').addEventListener('click', () => void exportEgv());
  $('btnCenterHead').addEventListener('click', () => !busy && void moveHeadTo(anchor.x, anchor.y));
  $('btnGoto').addEventListener('click', () => {
    if (busy) return;
    anchor.x = parseFloat($<HTMLInputElement>('gotoX').value.replace(',', '.')) * MIL_PER_MM || 0;
    anchor.y = parseFloat($<HTMLInputElement>('gotoY').value.replace(',', '.')) * MIL_PER_MM || 0;
    clampAnchor();
    void moveHeadTo(anchor.x, anchor.y);
    updateInfo();
    draw();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-jog]').forEach((b) =>
    b.addEventListener('click', () => {
      const [dx, dy] = b.dataset.jog!.split(',').map(Number);
      jog(dx, dy);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-corner]').forEach((b) => b.addEventListener('click', () => moveToCorner(b.dataset.corner!)));
  for (const id of ['opRaster', 'opEngrave', 'opCut']) $(id).addEventListener('change', () => void refreshSim());
  $('showSim').addEventListener('change', () => void refreshSim());

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input,select,textarea,dialog')) return;
    const map: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (map[e.key]) {
      e.preventDefault();
      jog(...map[e.key]);
    }
  });

  // Drag & Drop
  stage.addEventListener('dragover', (e) => {
    e.preventDefault();
    stage.classList.add('dragover');
  });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  });

  new ResizeObserver(() => draw()).observe(stage);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());

  if (K40Usb.isSupported()) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (laser && (e as USBConnectionEvent).device === laser.device) {
        laser = null;
        homed = false;
        responsive = null;
        abortRequested = true;
        updateButtons();
        updateInfo();
        setStatus('Laser wurde getrennt (USB).', 'warn');
      }
    });
    // Wieder eingesteckt / eingeschaltet: automatisch verbinden (nur bereits freigegebene Geräte)
    navigator.usb.addEventListener('connect', (e) => {
      const device = (e as USBConnectionEvent).device;
      if (laser || autoConnecting || !K40Usb.matches(device)) return;
      autoConnecting = true;
      K40Usb.fromDevice(device)
        .then((k) => attach(k, false))
        .then(() => {
          if (responsive) setStatus('Laser wieder verbunden. Bitte „Home“ drücken, damit die Position bekannt ist.', 'warn');
        })
        .catch((err) => setStatus(`Automatisches Verbinden fehlgeschlagen: ${(err as Error).message}`, 'error'))
        .finally(() => (autoConnecting = false));
    });
    // Im Leerlauf regelmäßig prüfen, ob der Controller noch antwortet
    setInterval(() => void pollStatus(), 3000);
    // bereits freigegebenes Gerät automatisch verbinden (ohne Fahrbewegung)
    K40Usb.reconnect()
      .then((k) => k && attach(k, false).then(() => setStatus('Laser verbunden. Bitte „Home“ drücken, damit die Position bekannt ist.')))
      .catch(() => undefined);
  } else {
    setStatus('Dieser Browser unterstützt kein WebUSB. Bitte Google Chrome oder Microsoft Edge verwenden.', 'warn');
  }

  updateButtons();
  updateInfo();
  draw();
}

init();
