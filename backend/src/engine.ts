import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { eventsRepo, printsRepo } from './db.js';
import { captureForDataset } from './camera.js';
import { sendPush } from './push.js';
import { describeKlipperError } from './errors.js';
import type { Fleet } from './fleet.js';
import type { LiveState, PrinterEvent, EventType, Severity } from './types.js';

interface Track {
  prev?: LiveState;
  printId?: number;             // active dataset print row
  snapshotDir?: string;
  captureTimer?: NodeJS.Timeout;
  lastProgress: number;
  lastProgressAt: number;
  stallNotified: boolean;
  lastFilament?: boolean | null;
  lastFaultCode?: number;       // last Creality fault seen (0 = none, undefined = unknown)
  heatIdleSince?: number;       // heaters on while nothing is printing, since
  heatAlerted?: boolean;
  heatOffAt?: number;           // when we sent TURN_OFF_HEATERS
  heatOffFailed?: boolean;
  vendorBusySince?: number;     // firmware pre-print phase started (Klipper not printing yet)
  idleOnSince?: Record<string, number>; // light/fan -> when it was first seen on while idle
  acc?: { n: number; power: number; nPower: number; vel: number; nVel: number; z: number | null; fan0: number | null };
  inPrint?: boolean;            // we've seen this print running (printing/paused)
  lastKlipperError?: string;    // last Klipper error already alerted
  faultAlerted?: boolean;       // current Creality fault was alerted (not a mirror of a Klipper error)
}

const FAULT_SETTLE_MS = 5000;

const FAN_NAMES: Record<string, string> = { fan0: 'the part-cooling fan', fan1: 'the side fan', fan2: 'the chamber fan' };

// The firmware's pre-print phase (heat, self-test, levelling) never legitimately runs
// this long; past it, a "busy" firmware with no print is treated as stuck.
const MAX_PREPRINT_MS = 60 * 60_000;

const PUSH_FOR: Partial<Record<EventType, boolean>> = {
  print_finished: true, print_cancelled: true, filament_runout: true,
  klipper_error: true, printer_offline: true, stall_suspected: true,
  printer_fault: true, heaters_idle: true, heaters_off: true, ai_failure: true,
};

export class Engine {
  private tracks = new Map<number, Track>();

  constructor(
    private fleet: Fleet,
    private broadcast: (e: PrinterEvent) => void,
  ) {}

  start() {
    this.fleet.on('state', (s: LiveState) => this.onState(s));
    // Heater watchdog also runs on a timer, in case a printer goes quiet.
    setInterval(() => { for (const s of this.fleet.getStates()) { this.checkHeaters(s); this.checkIdlePeripherals(s); } }, 30_000);
    setInterval(() => this.sampleMotion(), 5_000);
    const closed = printsRepo.closeFragments();
    if (closed) console.log(`[engine] closed ${closed} split print fragment(s) as 'continued'`);
  }

  private track(id: number): Track {
    let t = this.tracks.get(id);
    if (!t) { t = { lastProgress: 0, lastProgressAt: Date.now(), stallNotified: false }; this.tracks.set(id, t); }
    return t;
  }

  /** Raise an event from another component (stored, broadcast, pushed per PUSH_FOR). */
  report(e: Omit<PrinterEvent, 'createdAt'>) { return this.emit(e); }

  private async emit(e: Omit<PrinterEvent, 'createdAt'>) {
    const full: PrinterEvent = { ...e, createdAt: Date.now() };
    eventsRepo.add(full);
    this.broadcast(full);
    if (PUSH_FOR[full.type]) {
      await sendPush({
        title: full.title,
        body: full.message,
        tag: `printer-${full.printerId}`,
        severity: full.severity,
        printerId: full.printerId,
      }).catch(() => {});
    }
  }

  private printerName(id: number) {
    return this.fleet.client(id)?.printer.name || `Printer ${id}`;
  }

  private onState(s: LiveState) {
    const t = this.track(s.printerId);
    const prev = t.prev;
    const name = this.printerName(s.printerId);
    const mk = (type: EventType, severity: Severity, title: string, message: string, actionTaken?: string) =>
      this.emit({ printerId: s.printerId, printerName: name, type, severity, title, message,
                  filename: s.filename ?? null, actionTaken: actionTaken ?? null });

    // ---- Connectivity transitions ----
    // A print keeps running on the printer while we're disconnected, so don't end
    // its tracking here; the state after reconnecting decides what happened.
    if (prev && prev.online && !s.online) {
      const during = prev.state === 'printing' || prev.state === 'paused';
      mk('printer_offline', during ? 'warning' : 'info', `${name} offline`,
         during ? `Lost connection to ${name} during a print.` : `${name} went offline.`);
    }

    // ---- Print lifecycle ----
    // Only announce a start/finish we actually observed. `inPrint` survives
    // reconnects and backend restarts don't set it, so neither can replay a
    // finished print or re-announce a running one.
    if (s.online) {
      const active = s.state === 'printing' || s.state === 'paused';
      if (active && !t.inPrint) {
        t.inPrint = true;
        // A real start: we saw the printer online and idle just before.
        // ('offline' is our own placeholder right after connecting, never a real Klipper state.)
        const sawStart = !!prev && prev.online && !['printing', 'paused', 'offline'].includes(prev.state);
        if (s.state === 'printing' && sawStart)
          mk('print_started', 'info', `${name} started a print`, `${s.filename || 'A print'} started.`);
        if (!t.printId) this.startPrint(s, sawStart);   // also covers joining a print already in progress
      } else if (t.inPrint && !active) {
        t.inPrint = false;
        if (s.state === 'complete') {
          mk('print_finished', 'info', `✅ ${name} finished`, `${s.filename || 'Print'} completed.`);
          this.endPrint(s.printerId, 'completed');
        } else if (s.state === 'cancelled') {
          mk('print_cancelled', 'warning', `${name} print cancelled`, `${s.filename || 'Print'} was cancelled.`);
          this.endPrint(s.printerId, 'cancelled');
        } else if (s.state === 'error') {
          this.endPrint(s.printerId, 'error');      // alert raised below
        } else {
          this.endPrint(s.printerId, 'unknown');    // e.g. printer rebooted mid-print
        }
      }
      if (s.state === 'paused' && prev?.state === 'printing')
        mk('paused', 'info', `${name} paused`, `${s.filename || 'Print'} paused.`);
    }

    // ---- Klipper errors: once per distinct error, not on every reconnect ----
    if (s.online && s.state === 'error') {
      const msg = s.stateMessage || '';
      if (msg !== t.lastKlipperError) {
        t.lastKlipperError = msg;
        const { text, hint } = describeKlipperError(msg);
        mk('klipper_error', 'critical', `⚠️ ${name} error`, `${text || `${name} reported a printer error.`}${hint ? ` ${hint}` : ''}`,
           config.autoPauseOnError ? 'halted' : undefined);
      }
    } else if (s.online && s.state !== 'error') {
      t.lastKlipperError = undefined;
    }

    // ---- Filament runout (while printing) ----
    const fil = s.filamentDetected;
    if (s.state === 'printing' && fil === false && t.lastFilament !== false) {
      const action = config.autoPauseOnRunout ? 'auto-paused' : undefined;
      mk('filament_runout', 'critical', `🧵 ${name} out of filament`,
         `Filament runout detected on ${name}${action ? ' — auto-pausing.' : '.'}`, action);
      if (config.autoPauseOnRunout) this.fleet.client(s.printerId)?.pause().catch(() => {});
    }
    t.lastFilament = fil;

    // ---- Stall heuristic: progress frozen while "printing" ----
    if (s.state === 'printing') {
      if (s.progress > t.lastProgress + 0.0005) {
        t.lastProgress = s.progress; t.lastProgressAt = Date.now(); t.stallNotified = false;
      } else if (!t.stallNotified && Date.now() - t.lastProgressAt > config.stallMinutes * 60_000) {
        t.stallNotified = true;
        mk('stall_suspected', 'warning', `⏳ ${name} may be stalled`,
           `No print progress on ${name} for ${config.stallMinutes}+ min — check for a failure.`);
      }
    } else {
      t.lastProgress = s.progress; t.lastProgressAt = Date.now(); t.stallNotified = false;
    }

    // ---- Creality firmware faults (from :9999, invisible to Moonraker) ----
    // When Klipper itself errors, the firmware mirrors it as a Creality fault too
    // (Usopp: Klipper key586 -> Creality 2586). Klipper's alert already covers that,
    // so wait briefly (the two feeds arrive in either order) and stay quiet if so.
    if (s.fault !== undefined) {
      const code = s.fault?.code ?? 0;
      if (code && code !== t.lastFaultCode) {
        t.faultAlerted = false;
        setTimeout(() => {
          const cur = this.fleet.getState(s.printerId);
          if (!cur?.fault || cur.fault.code !== code || cur.state === 'error') return;
          t.faultAlerted = true;
          const heat = cur.bedTarget > 0 || cur.extruderTarget > 0
            ? ` Heaters are still on (bed ${cur.bedTarget}°C, nozzle ${cur.extruderTarget}°C).` : '';
          this.emit({ printerId: s.printerId, printerName: name, type: 'printer_fault', severity: 'critical',
                      title: `⚠️ ${name}: error ${code}`, message: `${cur.fault.description}.${heat}`,
                      filename: cur.filename ?? null, actionTaken: null });
        }, FAULT_SETTLE_MS);
      } else if (!code && t.lastFaultCode && t.faultAlerted) {
        mk('fault_cleared', 'info', `${name} error cleared`, `Error ${t.lastFaultCode} was cleared on the printer.`);
      }
      if (!code) t.faultAlerted = false;
      t.lastFaultCode = code;
    }

    this.checkHeaters(s);
    this.checkIdlePeripherals(s);
    t.prev = s;
  }

  /**
   * Light + switchable fans: switch off anything that has been on for IDLE_OFF_MIN
   * while nothing is printing. Timed per device, so a light turned on later still
   * gets its full time. Uses Creality's own macros (M107 also clears the fan-enable
   * pin). Automatic hotend/chamber fans are never touched.
   */
  private checkIdlePeripherals(s: LiveState) {
    if (config.idleOffMin <= 0) return;
    const t = this.track(s.printerId);
    const on = t.idleOnSince ??= {};
    const now = Date.now();
    const preprintActive = !!s.vendorBusy && s.state !== 'printing'
      && (!t.vendorBusySince || now - t.vendorBusySince < MAX_PREPRINT_MS);
    const idle = s.online && s.state !== 'printing' && s.state !== 'paused' && !preprintActive;
    const p = s.peripherals || {};
    const due: string[] = [];
    for (const key of ['light', 'fan0', 'fan1', 'fan2'] as const) {
      if (!idle || !((p[key] ?? 0) > 0)) { delete on[key]; continue; }
      on[key] ??= now;
      if (now - on[key] >= config.idleOffMin * 60_000) due.push(key);
    }
    if (!due.length) return;
    for (const k of due) on[k] = now;   // if it's still on afterwards, try again one interval later
    const client = this.fleet.client(s.printerId);
    if (!client) return;
    const script = due.map(k => (k === 'light' ? 'SET_PIN PIN=LED VALUE=0' : `M107 P${k.slice(3)}`)).join('\n');
    const what = [due.includes('light') ? 'the light' : '', ...due.filter(k => k !== 'light').map(k => FAN_NAMES[k])]
      .filter(Boolean).join(' and ').replace(/ and (?=.* and )/g, ', ');
    const name = this.printerName(s.printerId);
    client.gcode(script)
      .then(() => this.emit({ printerId: s.printerId, printerName: name, type: 'idle_off', severity: 'info',
        title: `💡 ${name}: switched off ${what}`, message: `Nothing has been printing for ${config.idleOffMin}+ min, so ${what} ${due.length > 1 ? 'were' : 'was'} switched off.`,
        filename: null, actionTaken: 'switched off' }))
      .catch((e: any) => console.warn(`[engine] couldn't switch off ${what} on ${name}: ${e?.message || e}`));
  }

  /**
   * Idle-heater watchdog. Heaters on while nothing is printing (e.g. a print that
   * halted in the firmware before reaching Klipper) -> alert, then turn them off.
   * A paused print only gets the alert, so it can still be resumed.
   */
  private checkHeaters(s: LiveState) {
    const t = this.track(s.printerId);
    const now = Date.now();
    const heating = s.online && (s.bedTarget > 0 || s.extruderTarget > 0);
    const preprint = !!s.vendorBusy && s.state !== 'printing';
    if (preprint) t.vendorBusySince ??= now; else t.vendorBusySince = undefined;
    const active = s.state === 'printing' || (preprint && now - t.vendorBusySince! < MAX_PREPRINT_MS);
    if (!heating || active) {
      t.heatIdleSince = undefined; t.heatAlerted = false; t.heatOffAt = undefined; t.heatOffFailed = false;
      return;
    }
    t.heatIdleSince ??= now;
    const mins = (now - t.heatIdleSince) / 60_000;
    const name = this.printerName(s.printerId);
    const paused = s.state === 'paused';
    const autoOff = !paused && config.idleHeaterOffMin > 0;
    const heaters = `bed ${s.bedTarget}°C, nozzle ${s.extruderTarget}°C`;
    const ev = (type: EventType, severity: Severity, title: string, message: string, actionTaken?: string) =>
      this.emit({ printerId: s.printerId, printerName: name, type, severity, title, message,
                  filename: s.filename ?? null, actionTaken: actionTaken ?? null });

    if (!t.heatAlerted && mins >= config.idleHeaterAlertMin) {
      t.heatAlerted = true;
      const lead = t.vendorBusySince
        ? `The printer has been stuck preparing a print for ${Math.round((now - t.vendorBusySince) / 60_000)} min with heaters on (${heaters}).`
        : `Heaters have been on for ${Math.round(mins)} min with nothing printing (${heaters}).`;
      const why = s.fault ? ` The printer is showing error ${s.fault.code}: ${s.fault.description}.`
                : paused ? ' The print is paused.' : '';
      ev('heaters_idle', 'warning', `🔥 ${name}: heaters on, not printing`, `${lead}${why}` +
         (autoOff ? ` They will be turned off automatically in ${Math.max(1, Math.round(config.idleHeaterOffMin - mins))} min.` : ''));
    }

    if (autoOff && !t.heatOffAt && mins >= config.idleHeaterOffMin) {
      t.heatOffAt = now;
      const client = this.fleet.client(s.printerId);
      (client ? client.gcode('TURN_OFF_HEATERS') : Promise.reject(new Error('not connected')))
        .then(() => ev('heaters_off', 'warning', `🧯 ${name}: heaters turned off`,
          `Heaters were on for ${Math.round(mins)} min with nothing printing (${heaters}), so they were switched off.`,
          'heaters turned off'))
        .catch((e: any) => ev('heaters_off', 'critical', `🔥 ${name}: could not turn heaters off`,
          `Tried to switch off idle heaters (${heaters}) but failed: ${e?.message || e}. Check the printer.`));
    } else if (t.heatOffAt && !t.heatOffFailed && now - t.heatOffAt > 5 * 60_000) {
      // We sent TURN_OFF_HEATERS 5+ min ago and they're still on: something re-enabled them.
      t.heatOffFailed = true;
      ev('heaters_off', 'critical', `🔥 ${name}: heaters still on`,
         `Heaters are still on (${heaters}) 5 min after being switched off. Check the printer.`);
    }
  }

  // ---- Dataset capture ----
  /**
   * Begin dataset capture. `fresh` = we saw the print start. When joining a print
   * already running (backend restart), continue its existing open row instead of
   * splitting it into a new one.
   */
  private startPrint(s: LiveState, fresh = true) {
    const t = this.track(s.printerId);
    if (t.printId) this.endPrint(s.printerId, 'unknown'); // safety
    const open = printsRepo.open(s.printerId);
    if (!fresh && open && open.filename === (s.filename ?? null) && open.snapshot_dir) {
      t.printId = open.id;
      t.snapshotDir = open.snapshot_dir;
      try { mkdirSync(join(config.dataDir, open.snapshot_dir), { recursive: true }); } catch { /* ignore */ }
    } else {
      const dir = join('snapshots', `p${s.printerId}_${Date.now()}`);
      try { mkdirSync(join(config.dataDir, dir), { recursive: true }); } catch { /* ignore */ }
      t.printId = printsRepo.start(s.printerId, s.filename ?? null, dir);
      t.snapshotDir = dir;
      printsRepo.closeOthers(s.printerId, t.printId);   // anything else still open is over
    }
    t.acc = undefined;
    if (config.datasetEnabled) {
      t.captureTimer = setInterval(() => this.capture(s.printerId), config.datasetSnapshotIntervalSec * 1000);
    }
  }

  private async capture(printerId: number) {
    const t = this.tracks.get(printerId);
    if (!t?.printId) return;
    const st = this.fleet.getState(printerId);
    const client = this.fleet.client(printerId);
    if (!st || !client) return;
    let snapName: string | null = null;
    try {
      const shot = await captureForDataset(client.printer);
      if (shot && t.snapshotDir) {
        snapName = `${Date.now()}.jpg`;
        writeFileSync(join(config.dataDir, t.snapshotDir, snapName), shot.body);
      }
    } catch { /* snapshot optional */ }
    const a = t.acc; t.acc = undefined;
    const avg = (sum: number, n: number) => (n ? sum / n : null);
    printsRepo.addTelemetry(t.printId, {
      progress: st.progress, bedTemp: st.bedTemp, bedTarget: st.bedTarget,
      extruderTemp: st.extruderTemp, extruderTarget: st.extruderTarget,
      printDuration: st.printDuration, filamentDetected: st.filamentDetected, snapshot: snapName,
      extruderPower: a ? avg(a.power, a.nPower) : null, extruderVelocity: a ? avg(a.vel, a.nVel) : null,
      z: a?.z ?? null, fan0: a?.fan0 ?? null, samples: a?.n ?? 0,
    });
  }

  /** Every 5 s while a print is tracked: accumulate heater power / commanded flow for the next telemetry row. */
  private sampleMotion() {
    for (const [id, t] of this.tracks) {
      if (!t.printId) continue;
      const v = this.fleet.sample(id);
      if (!v) continue;
      const a = t.acc ??= { n: 0, power: 0, nPower: 0, vel: 0, nVel: 0, z: null, fan0: null };
      a.n++;
      if (v.extruderPower !== null) { a.power += v.extruderPower; a.nPower++; }
      if (v.extruderVelocity !== null) { a.vel += Math.max(0, v.extruderVelocity); a.nVel++; }
      if (v.z !== null) a.z = v.z;
      if (v.fan0 !== null) a.fan0 = v.fan0;
    }
  }

  private endPrint(printerId: number, outcome: string) {
    const t = this.tracks.get(printerId);
    if (!t?.printId) return;
    if (t.captureTimer) clearInterval(t.captureTimer);
    printsRepo.end(t.printId, outcome);
    t.printId = undefined; t.snapshotDir = undefined; t.captureTimer = undefined;
  }
}
