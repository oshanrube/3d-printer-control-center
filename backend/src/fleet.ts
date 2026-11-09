import { EventEmitter } from 'node:events';
import { MoonrakerClient } from './moonraker.js';
import { CrealityClient, describeFault } from './creality.js';
import { describeKlipperError } from './errors.js';
import { printersRepo } from './db.js';
import type { AiVerdict, LiveState, Printer, PrintState } from './types.js';

function deepMerge(target: any, source: any): any {
  if (source == null || typeof source !== 'object') return source;
  if (target == null || typeof target !== 'object') target = Array.isArray(source) ? [] : {};
  for (const k of Object.keys(source)) {
    const v = source[k];
    target[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(target[k], v) : v;
  }
  return target;
}

function mapState(klippyPrintState: string | undefined, online: boolean): PrintState {
  if (!online) return 'offline';
  switch (klippyPrintState) {
    case 'printing': return 'printing';
    case 'paused': return 'paused';
    case 'complete': return 'complete';
    case 'cancelled': return 'cancelled';
    case 'error': return 'error';
    default: return 'standby';
  }
}

interface Entry {
  client: MoonrakerClient;
  vendor: CrealityClient; // Creality firmware feed (:9999): faults + pre-print phase
  ai?: AiVerdict | null;  // latest vision-model verdict (set by ai-analyzer)
  cache: any;           // merged Moonraker status objects
  state: LiveState;
}

/** Manages every printer connection and exposes normalized live state. */
export class Fleet extends EventEmitter {
  private entries = new Map<number, Entry>();

  start() {
    for (const p of printersRepo.all()) {
      if (!p.disabled) this.spawn(p);
    }
  }

  stop() {
    for (const e of this.entries.values()) { e.client.stop(); e.vendor.stop(); }
    this.entries.clear();
  }

  private blankState(p: Printer): LiveState {
    return {
      printerId: p.id, online: false, state: 'offline', progress: 0,
      printDuration: 0, totalDuration: 0, bedTemp: 0, bedTarget: 0,
      extruderTemp: 0, extruderTarget: 0, updatedAt: Date.now(),
    };
  }

  private spawn(p: Printer) {
    const client = new MoonrakerClient(p);
    const vendor = new CrealityClient(p);
    const entry: Entry = { client, vendor, cache: {}, state: this.blankState(p) };
    this.entries.set(p.id, entry);

    vendor.on('update', () => this.recompute(p.id));
    vendor.start();

    client.on('open', () => {
      entry.state.online = true;
      this.emitState(p.id);
    });
    client.on('close', () => {
      entry.state.online = false;
      entry.state.state = 'offline';
      entry.cache = {};
      this.emitState(p.id);
    });
    client.on('status', (status: any) => {
      deepMerge(entry.cache, status);
      this.recompute(p.id);
    });

    client.start();
  }

  private recompute(id: number) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const c = entry.cache;
    const ps = c.print_stats || {};
    const vs = c.virtual_sdcard || {};
    const bed = c.heater_bed || {};
    const ext = c.extruder || {};

    const online = entry.client.connected;
    const progress = typeof vs.progress === 'number' ? vs.progress : (entry.state.progress || 0);
    const printDuration = ps.print_duration ?? 0;
    const totalDuration = ps.total_duration ?? 0;
    let eta: number | null = null;
    if (progress > 0 && totalDuration > 0) eta = Math.max(0, totalDuration * (1 - progress));

    // Filament runout sensor (first one found): filament_detected true/false
    let filamentDetected: boolean | null = null;
    for (const name of entry.client.sensorNames) {
      const s = c[name];
      if (s && typeof s.filament_detected === 'boolean') { filamentDetected = s.filament_detected; break; }
    }

    const next: LiveState = {
      printerId: id,
      online,
      state: mapState(ps.state, online),
      stateMessage: ps.message || undefined,
      filename: ps.filename ?? null,
      progress,
      printDuration,
      totalDuration,
      etaSeconds: eta,
      bedTemp: Math.round((bed.temperature ?? 0) * 10) / 10,
      bedTarget: bed.target ?? 0,
      extruderTemp: Math.round((ext.temperature ?? 0) * 10) / 10,
      extruderTarget: ext.target ?? 0,
      filamentDetected,
      ...this.vendorFields(entry),
      ai: entry.ai ?? null,
      updatedAt: Date.now(),
    };
    if (next.state === 'error' && next.stateMessage) {
      const k = describeKlipperError(next.stateMessage);
      next.errorText = k.hint ? `${k.text}. ${k.hint}` : k.text;
      // The firmware mirrors Klipper errors as its own fault code; describe it with Klipper's message.
      if (next.fault) next.fault = { ...next.fault, description: next.errorText };
    }
    entry.state = next;
    this.emitState(id);
  }

  private vendorFields(entry: Entry): Pick<LiveState, 'fault' | 'vendorBusy'> {
    const v = entry.vendor.status;
    if (!v) return { fault: undefined, vendorBusy: false };
    return {
      fault: v.fault ? { code: v.fault.code, message: v.fault.message, description: describeFault(v.fault) } : null,
      vendorBusy: v.state === 1 && !v.fault,
    };
  }

  private emitState(id: number) {
    const e = this.entries.get(id);
    if (e) this.emit('state', e.state);
  }

  /** Attach the latest AI verdict to a printer's live state (pushed to dashboards). */
  setAi(id: number, verdict: AiVerdict | null) {
    const e = this.entries.get(id);
    if (!e) return;
    e.ai = verdict;
    e.state = { ...e.state, ai: verdict, updatedAt: Date.now() };
    this.emitState(id);
  }

  // ---- Public API ----
  getState(id: number): LiveState | undefined { return this.entries.get(id)?.state; }
  getStates(): LiveState[] { return [...this.entries.values()].map(e => e.state); }
  client(id: number): MoonrakerClient | undefined { return this.entries.get(id)?.client; }

  /** Reconcile running clients with the DB (after add/update/remove). */
  reconcile() {
    const wanted = new Map(printersRepo.all().filter(p => !p.disabled).map(p => [p.id, p]));
    for (const [id, e] of this.entries) {
      const p = wanted.get(id);
      if (!p) { e.client.stop(); e.vendor.stop(); this.entries.delete(id); }
      else if (p.ip !== e.client.printer.ip) { e.client.stop(); e.vendor.stop(); this.entries.delete(id); this.spawn(p); }
      else { e.client.printer = p; e.vendor.printer = p; }
    }
    for (const [id, p] of wanted) if (!this.entries.has(id)) this.spawn(p);
  }
}
