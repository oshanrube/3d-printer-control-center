import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Printer } from './types.js';
import { describeMirroredKlipperFault } from './errors.js';

/**
 * Read-only client for Creality's own status feed (ws://<printer>:9999), served by
 * the stock firmware on K1/K1C/K2. It sees things Moonraker can't: Creality fault
 * codes (e.g. 521 "AI detected objects on the bed") and the firmware's pre-print
 * phase (heating, self-test, levelling) before a job is ever handed to Klipper.
 *
 * The first message is a full snapshot; later messages are deltas. The only thing
 * we ever send is the light switch (setLight): switching the LED through this
 * service, as the Creality app does, keeps the touch screen in sync. Switching it
 * via Klipper's SET_PIN works but leaves the screen showing the old state.
 */

export interface CrealityFault { code: number; errcode: number; message: string; }

export interface VendorStatus {
  state?: number;        // Creality print state (1 = printing/preparing)
  deviceState?: number;
  model?: string;
  file?: string;         // file the firmware is printing / preparing (basename)
  fault: CrealityFault | null;
}

// Codes verified from printer logs. Others fall back to the firmware's own text.
const KNOWN: Record<number, string> = {
  521: 'AI camera detected objects on the bed before printing. Clear the build plate and restart',
};

export function describeFault(f: CrealityFault): string {
  return KNOWN[f.code] || describeMirroredKlipperFault(f.code, f.message) || f.message || `Creality error ${f.code}`;
}

const SILENCE_MS = 120_000;  // no messages this long -> assume a dead socket, reconnect
const RETRY_MS = 15_000;

export class CrealityClient extends EventEmitter {
  private ws?: WebSocket;
  private cache: any = {};
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private lastMsg = 0;
  status: VendorStatus | null = null;   // null = feed not connected / unknown

  constructor(public printer: Printer) { super(); }

  /** Switch the chamber light through Creality's service. False if the feed isn't connected. */
  setLight(on: boolean): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ method: 'set', params: { lightSw: on ? 1 : 0 } }));
    return true;
  }

  private host() { return String(this.printer.ip).replace(/^https?:\/\//, '').split(':')[0]; }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastMsg > SILENCE_MS) this.ws.terminate();
    }, 30_000);
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    try { this.ws?.terminate(); } catch { /* ignore */ }
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://${this.host()}:9999`, { handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => { this.cache = {}; this.lastMsg = Date.now(); });
    ws.on('message', (data) => {
      this.lastMsg = Date.now();
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      Object.assign(this.cache, msg);
      if ('err' in msg || 'state' in msg || 'deviceState' in msg || 'model' in msg || 'printFileName' in msg || !this.status) this.publish();
    });
    ws.on('error', () => { /* close handler retries */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.status !== null) { this.status = null; this.emit('update', null); }
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), RETRY_MS);
    });
  }

  private publish() {
    const c = this.cache;
    const e = c.err && typeof c.err === 'object' ? c.err : null;
    const code = Number(e?.key) || Number(e?.errcode) || 0;
    const next: VendorStatus = {
      state: typeof c.state === 'number' ? c.state : undefined,
      deviceState: typeof c.deviceState === 'number' ? c.deviceState : undefined,
      model: c.model,
      file: typeof c.printFileName === 'string' && c.printFileName ? c.printFileName.split('/').pop() : undefined,
      fault: code ? { code, errcode: Number(e?.errcode) || 0, message: String(e?.value || '').trim() } : null,
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) this.emit('update', next);
  }
}
