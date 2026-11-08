import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { eventsRepo, printsRepo } from './db.js';
import { fetchSnapshot } from './camera.js';
import { sendPush } from './push.js';
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
}

const PUSH_FOR: Partial<Record<EventType, boolean>> = {
  print_finished: true, print_cancelled: true, filament_runout: true,
  klipper_error: true, printer_offline: true, stall_suspected: true,
};

export class Engine {
  private tracks = new Map<number, Track>();

  constructor(
    private fleet: Fleet,
    private broadcast: (e: PrinterEvent) => void,
  ) {}

  start() {
    this.fleet.on('state', (s: LiveState) => this.onState(s));
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
    if (prev && prev.online && !s.online) {
      const during = prev.state === 'printing' || prev.state === 'paused';
      mk('printer_offline', during ? 'warning' : 'info', `${name} offline`,
         during ? `Lost connection to ${name} during a print.` : `${name} went offline.`);
      if (during && t.printId) this.endPrint(s.printerId, 'unknown');
    }

    // ---- Print-state transitions ----
    if (prev && prev.state !== s.state) {
      if (s.state === 'printing' && prev.state !== 'paused') {
        this.startPrint(s);
        mk('print_started', 'info', `${name} started a print`, `${s.filename || 'A print'} started.`);
      } else if (s.state === 'complete') {
        mk('print_finished', 'info', `✅ ${name} finished`, `${s.filename || 'Print'} completed.`);
        this.endPrint(s.printerId, 'completed');
      } else if (s.state === 'cancelled') {
        mk('print_cancelled', 'warning', `${name} print cancelled`, `${s.filename || 'Print'} was cancelled.`);
        this.endPrint(s.printerId, 'cancelled');
      } else if (s.state === 'error') {
        mk('klipper_error', 'critical', `⚠️ ${name} error`, s.stateMessage || `${name} reported a printer error.`,
           config.autoPauseOnError ? 'halted' : undefined);
        this.endPrint(s.printerId, 'error');
      } else if (s.state === 'paused' && prev.state === 'printing') {
        mk('paused', 'info', `${name} paused`, `${s.filename || 'Print'} paused.`);
      }
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

    t.prev = s;
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
      const shot = await fetchSnapshot(client.printer);
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
