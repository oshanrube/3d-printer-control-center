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
  // master-server.log: "ai detect discover foreign objects" (pre-print foreign-object check, confidence >= 62.5%)
  104: 'AI camera found a foreign object on the bed during the pre-print check. Remove it (or check the plate edge) and restart',
  521: 'AI camera detected objects on the bed before printing. Clear the build plate and restart',
  // Confirmed from Luffy's master-server.log (firmware 2.3.5.34, 2026-11-17): "current cavity temp = 61",
  // "The chamber temperature is too high, turn off the camera", error = 500, code = 509, then
  // `/usr/bin/chamber_cam_power.sh off`. Repeats every second while the chamber stays that hot.
  509: 'Chamber too hot for the camera (about 61°C): the printer switched its camera off to protect it. The print carries on, but camera checks are blind until it cools',
};

export function describeFault(f: CrealityFault): string {
  return KNOWN[f.code] || describeMirroredKlipperFault(f.code, f.message) || f.message
    // 5xx are the firmware's AI camera checks (521, 509, ...): say so rather than a bare number.
    || (f.code >= 500 && f.code < 600 ? `AI camera check (code ${f.code}): the printer's camera flagged something` : '')
    || `Creality error ${f.code}`;
}

const SILENCE_MS = 120_000;  // no messages this long -> assume a dead socket, reconnect
const RETRY_MS = 15_000;

/** A spool the printer knows about: its filament box slots (K2 CFS) and the external spool. */
export interface Spool {
  slot: string;          // "External", "CFS 1A" ...
  material: string;      // "PLA", "ABS" ...
  colour: string;        // "#rrggbb"
  name: string;          // "Hyper PLA"
}
const SPOOL_REFRESH_MS = 5 * 60_000;

export class CrealityClient extends EventEmitter {
  private ws?: WebSocket;
  private cache: any = {};
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private lastMsg = 0;
  status: VendorStatus | null = null;   // null = feed not connected / unknown
  // Spools set on the printer (firmware 2.x K1/K1C and the K2 answer "get boxsInfo";
  // 1.3.x K1C firmware doesn't). undefined = not asked yet, null = printer doesn't report.
  spools: Spool[] | null | undefined = undefined;
  spoolsAt = 0;
  private spoolTimer?: NodeJS.Timeout;
  private spoolProbe?: NodeJS.Timeout;

  constructor(public printer: Printer) { super(); }

  /** Switch the chamber light through Creality's service. False if the feed isn't connected. */
  /** Ask the printer which spools are loaded (read-only request). */
  refreshSpools(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ method: 'get', params: { boxsInfo: 1 } }));
    clearTimeout(this.spoolProbe);
    // No answer at all within 6 s: this firmware doesn't report spools.
    if (this.spools === undefined) this.spoolProbe = setTimeout(() => { if (this.spools === undefined) { this.spools = null; this.emit('spools', null); } }, 6000);
    return true;
  }

  private parseSpools(info: any) {
    const out: Spool[] = [];
    for (const box of Array.isArray(info?.materialBoxs) ? info.materialBoxs : []) {
      const external = Number(box.type) === 1;
      for (const m of Array.isArray(box.materials) ? box.materials : []) {
        if (!m || !String(m.type || '').trim() || Number(m.state) <= 0) continue;   // empty slot
        let colour = String(m.color || '').trim().toLowerCase();
        if (/^#0[0-9a-f]{6}$/.test(colour)) colour = '#' + colour.slice(2);         // firmware writes "#0rrggbb"
        out.push({ slot: external ? 'External' : `CFS ${box.id}${'ABCD'[Number(m.id)] ?? m.id}`,
          material: String(m.type).trim(), colour, name: String(m.name || '').trim() });
      }
    }
    this.spools = out; this.spoolsAt = Date.now();
    clearTimeout(this.spoolProbe);
    this.emit('spools', out);
  }

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
    clearInterval(this.spoolTimer); clearTimeout(this.spoolProbe);
    try { this.ws?.terminate(); } catch { /* ignore */ }
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://${this.host()}:9999`, { handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => {
      this.cache = {}; this.lastMsg = Date.now();
      setTimeout(() => this.refreshSpools(), 1500);
      clearInterval(this.spoolTimer);
      this.spoolTimer = setInterval(() => { if (this.spools !== null) this.refreshSpools(); }, SPOOL_REFRESH_MS);
    });
    ws.on('message', (data) => {
      this.lastMsg = Date.now();
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.boxsInfo) { this.parseSpools(msg.boxsInfo); delete msg.boxsInfo; }
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
