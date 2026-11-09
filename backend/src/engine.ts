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
  inPrint?: boolean;            // we've seen this print running (printing/paused)
  lastKlipperError?: string;    // last Klipper error already alerted
  faultAlerted?: boolean;       // current Creality fault was alerted (not a mirror of a Klipper error)
}

const FAULT_SETTLE_MS = 5000;

// The firmware's pre-print phase (heat, self-test, levelling) never legitimately runs
// this long; past it, a "busy" firmware with no print is treated as stuck.
const MAX_PREPRINT_MS = 60 * 60_000;

const PUSH_FOR: Partial<Record<EventType, boolean>> = {
  print_finished: true, print_cancelled: true, filament_runout: true,
  klipper_error: true, printer_offline: true, stall_suspected: true,
  printer_fault: true, heaters_idle: true, heaters_off: true,
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
    setInterval(() => { for (const s of this.fleet.getStates()) this.checkHeaters(s); }, 30_000);
  }

  private track(id: number): Track {
    let t = this.tracks.get(id);
    if (!t) { t = { lastProgress: 0, lastProgressAt: Date.now(), stallNotified: false }; this.tracks.set(id, t); }
    return t;
  }

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
        const sawStart = !!prev && prev.online && prev.state !== 'printing' && prev.state !== 'paused';
        if (s.state === 'printing' && sawStart)
          mk('print_started', 'info', `${name} started a print`, `${s.filename || 'A print'} started.`);
        if (!t.printId) this.startPrint(s);   // also covers joining a print already in progress
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
    t.prev = s;
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
  private startPrint(s: LiveState) {
    const t = this.track(s.printerId);
    if (t.printId) this.endPrint(s.printerId, 'unknown'); // safety
    const dir = join('snapshots', `p${s.printerId}_${Date.now()}`);
    const abs = join(config.dataDir, dir);
    try { mkdirSync(abs, { recursive: true }); } catch { /* ignore */ }
    t.printId = printsRepo.start(s.printerId, s.filename ?? null, dir);
    t.snapshotDir = dir;
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
    printsRepo.addTelemetry(t.printId, {
      progress: st.progress, bedTemp: st.bedTemp, bedTarget: st.bedTarget,
      extruderTemp: st.extruderTemp, extruderTarget: st.extruderTarget,
      printDuration: st.printDuration, filamentDetected: st.filamentDetected, snapshot: snapName,
    });
  }

  private endPrint(printerId: number, outcome: string) {
    const t = this.tracks.get(printerId);
    if (!t?.printId) return;
    if (t.captureTimer) clearInterval(t.captureTimer);
    printsRepo.end(t.printId, outcome);
    t.printId = undefined; t.snapshotDir = undefined; t.captureTimer = undefined;
  }
}
