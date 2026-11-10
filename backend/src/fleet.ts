import { EventEmitter } from 'node:events';
import { MoonrakerClient } from './moonraker.js';
import { CrealityClient, describeFault } from './creality.js';
import { describeKlipperError } from './errors.js';
import { printersRepo } from './db.js';
import type { AiVerdict, LiveState, Printer, PrintState, RefVerdict } from './types.js';

function deepMerge(target: any, source: any): any {
  if (source == null || typeof source !== 'object') return source;
  if (target == null || typeof target !== 'object') target = Array.isArray(source) ? [] : {};
  for (const k of Object.keys(source)) {
    const v = source[k];
    target[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(target[k], v) : v;
  }
  return target;
}

function peripheralsFrom(c: any): LiveState['peripherals'] {
  const out: NonNullable<LiveState['peripherals']> = {};
  const v = (k: string) => (typeof c[k]?.value === 'number' ? c[k].value : undefined);
  if (v('output_pin LED') !== undefined) out.light = v('output_pin LED');
  for (const f of ['fan0', 'fan1', 'fan2'] as const) if (v(`output_pin ${f}`) !== undefined) out[f] = v(`output_pin ${f}`);
  return out;
}

function environmentFrom(c: any): Pick<LiveState, 'chamber' | 'fans'> {
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const r1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);
  const heater = c['heater_generic chamber_heater'];
  const temp = num(c['temperature_sensor chamber_temp']?.temperature) ?? num(heater?.temperature);
  const chamber = temp === undefined ? null : {
    temp: r1(temp)!,
    ...(heater ? { target: num(heater.target) ?? 0, heaterPower: num(heater.power) ?? 0 } : {}),
  };
  const manual = num(c['output_pin fan1']?.value);
  const auto = num(c['temperature_fan chamber_fan']?.speed);
  const fans: NonNullable<LiveState['fans']> = {};
  if (num(c['output_pin fan0']?.value) !== undefined) fans.part = num(c['output_pin fan0'].value);
  if (manual !== undefined || auto !== undefined) {
    fans.chamber = Math.max(manual ?? 0, auto ?? 0);
    fans.chamberAuto = (auto ?? 0) > (manual ?? 0);
  }
  if (num(c['output_pin fan2']?.value) !== undefined) fans.side = num(c['output_pin fan2'].value);
  if (num(c['heater_fan hotend_fan']?.speed) !== undefined) fans.hotend = num(c['heater_fan hotend_fan'].speed);
  if (num(c['heater_fan chamber_fan']?.speed) !== undefined) fans.heater = num(c['heater_fan chamber_fan'].speed);
  return { chamber, fans };
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
  reference?: RefVerdict | null; // latest reference-run comparison (set by ref-compare)
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
      // motion_report updates several times a second while moving; it only feeds
      // sample(), so don't rebuild/broadcast live state for it.
      if (Object.keys(status || {}).every(k => k === 'motion_report')) return;
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

    // Filament runout sensor (first *enabled* one): filament_detected true/false.
    // A disabled sensor always reads false (the K2's, which feeds from its rack/CFS),
    // and treating that as a runout auto-paused K2 prints.
    let filamentDetected: boolean | null = null;
    for (const name of entry.client.sensorNames) {
      const s = c[name];
      if (s && s.enabled !== false && typeof s.filament_detected === 'boolean') { filamentDetected = s.filament_detected; break; }
    }

    const next: LiveState = {
      printerId: id,
      online,
      // Until Klipper's first status arrives, the print state is unknown: keep the
      // 'offline' placeholder (which the engine ignores) instead of falling back to
      // 'standby'. The Creality feed can connect first after a restart, and a fake
      // standby -> printing looked like a new print (false "started", split dataset rows).
      state: ps.state === undefined ? 'offline' : mapState(ps.state, online),
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
      reference: entry.reference ?? null,
      peripherals: peripheralsFrom(c),
      ...environmentFrom(c),
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

  /**
   * Switch a printer's light. Prefers Creality's own service so the touch screen
   * stays in sync; falls back to Klipper's SET_PIN when that feed isn't connected.
   */
  async setLight(id: number, on: boolean): Promise<'creality' | 'klipper'> {
    const e = this.entries.get(id);
    if (!e) throw new Error('unknown printer');
    if (e.vendor.setLight(on)) return 'creality';
    await e.client.gcode(`SET_PIN PIN=LED VALUE=${on ? 1 : 0}`);
    return 'klipper';
  }

  /** Printer model as reported by Creality's firmware feed (e.g. "K1C", "F008"), if known. */
  model(id: number): string | null {
    return this.entries.get(id)?.vendor.status?.model || null;
  }

  /** Instantaneous hotend/motion readings for the dataset (jam-detection research). */
  sample(id: number): { extruderPower: number | null; extruderVelocity: number | null; z: number | null; fan0: number | null } | null {
    const c = this.entries.get(id)?.cache;
    if (!c) return null;
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      extruderPower: num(c.extruder?.power),
      extruderVelocity: num(c.motion_report?.live_extruder_velocity),
      z: num(c.motion_report?.live_position?.[2]),
      fan0: num(c['output_pin fan0']?.value),
    };
  }

  /** Attach the latest reference-run comparison to a printer's live state. */
  setReference(id: number, verdict: RefVerdict | null) {
    const e = this.entries.get(id);
    if (!e) return;
    e.reference = verdict;
    e.state = { ...e.state, reference: verdict, updatedAt: Date.now() };
    this.emitState(id);
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
