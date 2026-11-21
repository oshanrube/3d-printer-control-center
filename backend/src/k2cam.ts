import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Printer } from './types.js';

/**
 * K2 cameras through the printer's own `k2cam` service (tools/k2cam), instead of
 * the headless-Chromium WebRTC relay.
 *
 * On the printer, k2cam subscribes to cam_app's H.264 stream (Creality libdelivery)
 * and serves on :8080
 *   /keyframe           the latest keyframe (SPS+PPS+IDR, ~40 KB, once a second)
 *   /?action=snapshot   a JPEG decoded on the printer, on demand
 *
 * When the printer's k2cam encodes on the SoC's video engine (snapshot header
 * `X-Encoder: hw`, ~20 ms per frame on the printer), live view simply takes its JPEGs.
 * Otherwise keyframes are decoded here by one long-running ffmpeg per printer
 * (no per-frame start-up), only while someone is watching; it stops when idle.
 * Dataset/AI frames: reuse a fresh live frame, else ask the printer for a snapshot,
 * so an unwatched camera costs the Pi nothing.
 */

const PORT = 8080;
const IDLE_MS = 60_000;          // stop a printer's decoder this long after the last live request
const FRESH_MS = 900;            // a decoded frame this recent is served as is (keyframes come 1/s)
const DECODE_TIMEOUT_MS = 4_000;
const SIZE = process.env.K2CAM_SIZE || '1280:720';
// An access unit delimiter after each keyframe makes ffmpeg's parser finish the
// frame at once instead of waiting for the next one (a second later).
const AUD = Buffer.from([0, 0, 0, 1, 0x09, 0x10]);

function host(p: Printer): string {
  return String(p.ip).replace(/^https?:\/\//, '').split(':')[0];
}

class Decoder {
  private proc?: ChildProcessWithoutNullStreams;
  private out: Buffer = Buffer.alloc(0);
  private waiters: Array<(jpg: Buffer | null) => void> = [];
  frame: Buffer | null = null;
  frameAt = 0;
  private seq = -1;
  private busy?: Promise<Buffer | null>;
  lastUse = 0;

  constructor(private printer: Printer) {}

  private start() {
    const args = ['-hide_banner', '-loglevel', 'error', '-threads', '1',
      '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
      '-f', 'h264', '-i', 'pipe:0', '-vf', `scale=${SIZE}`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p; this.out = Buffer.alloc(0);
    p.stdout.on('data', (d: Buffer) => this.onData(d));
    p.stderr.on('data', (d: Buffer) => { const s = d.toString().trim(); if (s) console.warn(`[k2cam] ffmpeg ${this.printer.name}: ${s.slice(0, 200)}`); });
    p.stdin.on('error', () => { /* handled by exit */ });
    p.on('exit', () => {
      if (this.proc === p) this.proc = undefined;
      this.seq = -1;
      for (const w of this.waiters.splice(0)) w(null);
    });
    p.on('error', (e) => console.warn(`[k2cam] ffmpeg failed to start: ${e.message}`));
  }

  /** Split complete JPEGs (SOI .. EOI) out of ffmpeg's output. */
  private onData(d: Buffer) {
    this.out = this.out.length ? Buffer.concat([this.out, d]) : d;
    for (;;) {
      const soi = this.out.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { this.out = Buffer.alloc(0); return; }
      const eoi = this.out.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) { if (soi > 0) this.out = this.out.subarray(soi); return; }
      const jpg = Buffer.from(this.out.subarray(soi, eoi + 2));
      this.out = this.out.subarray(eoi + 2);
      this.frame = jpg; this.frameAt = Date.now();
      const w = this.waiters.shift(); if (w) w(jpg);
    }
  }

  stop() { try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ } this.proc = undefined; }

  /** Latest decoded frame, fetching and decoding a newer keyframe when needed. */
  get(): Promise<Buffer | null> {
    this.lastUse = Date.now();
    if (this.frame && Date.now() - this.frameAt < FRESH_MS) return Promise.resolve(this.frame);
    if (!this.busy) this.busy = this.refresh().finally(() => { this.busy = undefined; });
    return this.busy;
  }

  private async refresh(): Promise<Buffer | null> {
    const res = await fetch(`http://${host(this.printer)}:${PORT}/keyframe`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res || !res.ok) return null;
    const seq = Number(res.headers.get('x-seq') ?? -1);
    const kf = Buffer.from(await res.arrayBuffer());
    if (seq === this.seq && this.frame) return this.frame;     // nothing newer on the printer yet
    if (!this.proc) this.start();
    const p = this.proc!;
    const got = new Promise<Buffer | null>((resolve) => {
      const t = setTimeout(() => { const i = this.waiters.indexOf(done); if (i >= 0) this.waiters.splice(i, 1); resolve(null); }, DECODE_TIMEOUT_MS);
      const done = (jpg: Buffer | null) => { clearTimeout(t); resolve(jpg); };
      this.waiters.push(done);
    });
    this.seq = seq;
    p.stdin.write(Buffer.concat([kf, AUD]));
    return got;
  }
}

const decoders = new Map<number, Decoder>();

setInterval(() => {
  for (const [id, d] of decoders) if (Date.now() - d.lastUse > IDLE_MS) { d.stop(); decoders.delete(id); }
}, 10_000).unref();

// Printers whose k2cam encodes JPEGs on the SoC's video engine (X-Encoder: hw): live view
// takes their JPEGs directly and the Pi decodes nothing. Re-checked every 10 min.
const hwPrinters = new Map<number, { hw: boolean; at: number }>();
const lastHw = new Map<number, { jpg: Buffer; at: number; busy?: Promise<Buffer | null> }>();

async function printerSnapshot(printer: Printer, timeoutMs: number): Promise<{ jpg: Buffer; hw: boolean } | null> {
  const res = await fetch(`http://${host(printer)}:${PORT}/?action=snapshot`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!res || !res.ok) return null;
  const jpg = Buffer.from(await res.arrayBuffer());
  const hw = res.headers.get('x-encoder') === 'hw';
  hwPrinters.set(printer.id, { hw, at: Date.now() });
  return jpg.length > 100 ? { jpg, hw } : null;
}

/** Live view: the printer's hardware JPEGs when it has them, else keyframes decoded on the Pi. */
export async function k2LiveFrame(printer: Printer): Promise<Buffer | null> {
  const known = hwPrinters.get(printer.id);
  if (!known || known.hw || Date.now() - known.at > 600_000) {
    let c = lastHw.get(printer.id);
    if (c && Date.now() - c.at < FRESH_MS) return c.jpg;
    if (!c?.busy) {
      const p = printerSnapshot(printer, 5_000).then(r => {
        if (r?.hw) { lastHw.set(printer.id, { jpg: r.jpg, at: Date.now() }); return r.jpg; }
        lastHw.delete(printer.id);
        return null;
      });
      c = { jpg: c?.jpg ?? Buffer.alloc(0), at: c?.at ?? 0, busy: p };
      lastHw.set(printer.id, c);
      p.finally(() => { const cur = lastHw.get(printer.id); if (cur?.busy === p) cur.busy = undefined; });
    }
    const jpg = await c.busy!;
    if (jpg) return jpg;
    if (hwPrinters.get(printer.id)?.hw) return null;   // hardware printer, just no frame right now
  }
  let d = decoders.get(printer.id);
  if (!d) { d = new Decoder(printer); decoders.set(printer.id, d); }
  return d.get();
}

/**
 * Occasional frames (dataset, AI): a fresh live frame if someone is watching,
 * otherwise one JPEG decoded on the printer, so the Pi does no work for it.
 */
export async function k2Capture(printer: Printer): Promise<Buffer | null> {
  const c = lastHw.get(printer.id);
  if (c && c.jpg.length && Date.now() - c.at < 5_000) return c.jpg;
  const d = decoders.get(printer.id);
  if (d?.frame && Date.now() - d.frameAt < 5_000) return d.frame;
  return (await printerSnapshot(printer, 12_000))?.jpg ?? null;
}

export function stopK2Decoders() { for (const d of decoders.values()) d.stop(); decoders.clear(); }
