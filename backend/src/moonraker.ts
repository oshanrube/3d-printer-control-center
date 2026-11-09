import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Printer } from './types.js';

// Print control macros (pause/resume/cancel) can run for minutes before Moonraker replies.
const ACTION_TIMEOUT_MS = 10 * 60_000;

// Light + switchable fans on Creality K1/K1C/K2. fan0 = part cooling, fan1 = chamber
// (exhaust) fan, fan2 = side (auxiliary) fan. fan1 shares its pin with the automatic
// `temperature_fan chamber_fan`, so the same physical fan is driven by either.
export const PERIPHERAL_OBJECTS = ['output_pin LED', 'output_pin fan0', 'output_pin fan1', 'output_pin fan2'];

// Chamber + automatic fans, for display. chamber_temp is the reliable chamber reading
// (the temperature_fan reads the same thermistor with a different table on the K1C).
export const ENV_OBJECTS = [
  'temperature_sensor chamber_temp', 'heater_generic chamber_heater',
  'temperature_fan chamber_fan', 'heater_fan hotend_fan', 'heater_fan chamber_fan',
];

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout };

/**
 * One resilient JSON-RPC connection to a printer's Moonraker.
 * Emits:
 *   'status'  (merged status objects)   — notify_status_update / initial query
 *   'open'                               — websocket connected + subscribed
 *   'close'                              — websocket closed (will auto-reconnect unless stopped)
 */
export class MoonrakerClient extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private subscribedSensors: string[] = [];
  peripheralObjects: string[] = [];
  readonly host: string;
  readonly port: number;
  connected = false;

  constructor(public printer: Printer) {
    super();
    const [h, p] = String(printer.ip).replace(/^wss?:\/\//, '').split(':');
    this.host = h;
    this.port = p ? parseInt(p, 10) : printer.moonrakerPort || 7125;
  }

  private url() { return `ws://${this.host}:${this.port}/websocket`; }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url(), { handshakeTimeout: 8000 });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', async () => {
      this.connected = true;
      try {
        await this.subscribe();
        this.emit('open');
      } catch {
        try { ws.close(); } catch { /* ignore */ }
      }
    });

    ws.on('message', (data) => this.onMessage(data.toString()));

    ws.on('close', () => {
      this.connected = false;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('closed')); }
      this.pending.clear();
      this.emit('close');
      this.scheduleReconnect();
    });

    ws.on('error', () => { /* 'close' will follow */ });
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 5000);
  }

  private onMessage(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'notify_status_update' && Array.isArray(msg.params)) {
      this.emit('status', msg.params[0]);
    } else if (msg.method === 'notify_klippy_shutdown') {
      this.emit('status', { print_stats: { state: 'error', message: 'Klipper shutdown' } });
    } else if (msg.method === 'notify_klippy_ready') {
      this.rquery().catch(() => {});
    }
  }

  private rpc(method: string, params?: any, timeoutMs = 10000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('rpc timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  private async subscribe() {
    // Discover filament sensors so we can watch runout.
    this.subscribedSensors = [];
    try {
      const list = await this.rpc('printer.objects.list', {});
      const objs: string[] = list?.objects || [];
      this.subscribedSensors = objs.filter(o =>
        o.startsWith('filament_switch_sensor') || o.startsWith('filament_motion_sensor'));
      // Creality K-series light and fans (plain output pins). Automatic fans
      // (heater_fan / temperature_fan) are deliberately not included.
      this.peripheralObjects = [...PERIPHERAL_OBJECTS, ...ENV_OBJECTS].filter(o => objs.includes(o));
    } catch { /* sensors optional */ }

    const objects: Record<string, null> = {
      print_stats: null, heater_bed: null, extruder: null,
      display_status: null, virtual_sdcard: null, idle_timeout: null,
    };
    for (const s of this.subscribedSensors) objects[s] = null;
    for (const p of this.peripheralObjects) objects[p] = null;
    // Live commanded extrusion speed + Z, sampled for the dataset (not part of LiveState).
    objects['motion_report'] = null;

    const res = await this.rpc('printer.objects.subscribe', { objects });
    if (res?.status) this.emit('status', res.status); // initial snapshot
  }

  /** Re-query a full snapshot (used after reconnect / klippy ready). */
  async rquery() {
    const objects: Record<string, null> = {
      print_stats: null, heater_bed: null, extruder: null,
      display_status: null, virtual_sdcard: null,
    };
    for (const s of this.subscribedSensors) objects[s] = null;
    for (const p of this.peripheralObjects) objects[p] = null;
    const res = await this.rpc('printer.objects.query', { objects });
    if (res?.status) this.emit('status', res.status);
  }

  get sensorNames() { return this.subscribedSensors; }

  // ---- Control actions ----
  // Moonraker only replies once the macro finishes, and Creality's PAUSE/CANCEL
  // macros park the head and wait for cooling, which can take minutes.
  pause()  { return this.rpc('printer.print.pause', {}, ACTION_TIMEOUT_MS); }
  resume() { return this.rpc('printer.print.resume', {}, ACTION_TIMEOUT_MS); }
  cancel() { return this.rpc('printer.print.cancel', {}, ACTION_TIMEOUT_MS); }
  emergencyStop() { return this.rpc('printer.emergency_stop', {}); }
  gcode(script: string) { return this.rpc('printer.gcode.script', { script }); }
}
