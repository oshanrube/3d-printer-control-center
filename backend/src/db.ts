import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { Printer, PrinterEvent } from './types.js';

// The data dir lives on the Pi's NVMe, which is mounted with `nofail`. If the drive
// ever fails to mount, the bind mount would point at an empty folder and we'd silently
// start a fresh database (losing push subscriptions, history, the dataset). Refuse to
// start instead when the marker file is missing.
if (process.env.DATA_MARKER && !existsSync(join(config.dataDir, process.env.DATA_MARKER))) {
  console.error(`[db] FATAL: ${join(config.dataDir, process.env.DATA_MARKER)} not found. Is the data drive mounted? Refusing to start.`);
  process.exit(1);
}
mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(join(config.dataDir, 'control-center.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS printers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  moonraker_port INTEGER NOT NULL DEFAULT 7125,
  camera_type TEXT NOT NULL DEFAULT 'auto',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id INTEGER NOT NULL,
  printer_name TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  filename TEXT,
  action_taken TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A print job session, labeled with its outcome (for future AI training).
CREATE TABLE IF NOT EXISTS prints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id INTEGER NOT NULL,
  filename TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,              -- completed | cancelled | error | failed | unknown
  duration_sec INTEGER,
  snapshot_dir TEXT          -- relative dir holding captured frames
);
CREATE INDEX IF NOT EXISTS idx_prints_printer ON prints(printer_id);

-- Time-series telemetry captured during a print (training features).
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL,
  t INTEGER NOT NULL,         -- epoch ms
  progress REAL,
  bed_temp REAL,
  bed_target REAL,
  extruder_temp REAL,
  extruder_target REAL,
  print_duration REAL,
  filament_detected INTEGER,  -- 1/0/null
  snapshot TEXT               -- filename of captured frame at this sample, if any
);
CREATE INDEX IF NOT EXISTS idx_telemetry_print ON telemetry(print_id);

-- Vision-model verdicts on print snapshots (ai-analyzer.ts). Joined with prints.outcome
-- these become labelled training/evaluation data.
CREATE TABLE IF NOT EXISTS ai_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id INTEGER NOT NULL,
  print_id INTEGER,            -- prints.id when a tracked print was running
  t INTEGER NOT NULL,          -- epoch ms
  snapshot TEXT,               -- path relative to the data dir
  assessment TEXT,             -- success | failure | inconclusive | error
  confidence INTEGER,          -- 0-100
  reason TEXT,
  defects TEXT,                -- JSON array
  progress REAL,
  model TEXT,
  latency_ms INTEGER,
  raw TEXT                     -- raw model reply (or error), for debugging
);
CREATE INDEX IF NOT EXISTS idx_ai_checks_printer ON ai_checks(printer_id, t);
`);

// Why a print failed, labelled by the user (training labels for failure detection).
{
  const cols = new Set((db.prepare('PRAGMA table_info(prints)').all() as any[]).map(c => c.name));
  if (!cols.has('failure_reason')) db.exec(`ALTER TABLE prints ADD COLUMN failure_reason TEXT`); // see FAILURE_REASONS
  if (!cols.has('failure_note')) db.exec(`ALTER TABLE prints ADD COLUMN failure_note TEXT`);
  if (!cols.has('labelled_at')) db.exec(`ALTER TABLE prints ADD COLUMN labelled_at INTEGER`);
}

// What happened to an event's push notification (e.g. "sent to 2/2").
{
  const cols = new Set((db.prepare('PRAGMA table_info(events)').all() as any[]).map(c => c.name));
  if (!cols.has('push_result')) db.exec(`ALTER TABLE events ADD COLUMN push_result TEXT`);
}

// Telemetry columns for jam detection research: heater power vs commanded flow.
{
  const cols = new Set((db.prepare('PRAGMA table_info(telemetry)').all() as any[]).map(c => c.name));
  if (!cols.has('extruder_power')) db.exec(`ALTER TABLE telemetry ADD COLUMN extruder_power REAL`);       // mean heater PWM 0-1 over the interval
  if (!cols.has('extruder_velocity')) db.exec(`ALTER TABLE telemetry ADD COLUMN extruder_velocity REAL`); // mean commanded filament speed, mm/s
  if (!cols.has('z')) db.exec(`ALTER TABLE telemetry ADD COLUMN z REAL`);
  if (!cols.has('fan0')) db.exec(`ALTER TABLE telemetry ADD COLUMN fan0 REAL`);                           // part-cooling fan 0-1
  if (!cols.has('samples')) db.exec(`ALTER TABLE telemetry ADD COLUMN samples INTEGER`);
}

// Columns added after ai_checks first shipped.
{
  const cols = new Set((db.prepare('PRAGMA table_info(ai_checks)').all() as any[]).map(c => c.name));
  if (!cols.has('source')) db.exec(`ALTER TABLE ai_checks ADD COLUMN source TEXT`);  // detector | vlm
  if (!cols.has('score')) db.exec(`ALTER TABLE ai_checks ADD COLUMN score REAL`);    // detector: summed confidences this frame
  if (!cols.has('risk')) db.exec(`ALTER TABLE ai_checks ADD COLUMN risk REAL`);      // detector: smoothed 0-1 failure risk
}

// ---- Printers ----
const rowToPrinter = (r: any): Printer => ({
  id: r.id, name: r.name, ip: r.ip, moonrakerPort: r.moonraker_port,
  cameraType: r.camera_type, disabled: !!r.disabled, createdAt: r.created_at,
});

export const printersRepo = {
  all(): Printer[] {
    return db.prepare('SELECT * FROM printers ORDER BY id').all().map(rowToPrinter);
  },
  get(id: number): Printer | undefined {
    const r = db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
    return r ? rowToPrinter(r) : undefined;
  },
  add(p: Omit<Printer, 'id' | 'createdAt'>): Printer {
    const createdAt = Date.now();
    const info = db.prepare(
      `INSERT INTO printers (name, ip, moonraker_port, camera_type, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(p.name, p.ip, p.moonrakerPort, p.cameraType, p.disabled ? 1 : 0, createdAt);
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<Printer>): Printer | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    db.prepare(
      `UPDATE printers SET name=?, ip=?, moonraker_port=?, camera_type=?, disabled=? WHERE id=?`
    ).run(next.name, next.ip, next.moonrakerPort, next.cameraType, next.disabled ? 1 : 0, id);
    return this.get(id);
  },
  remove(id: number): void {
    db.prepare('DELETE FROM printers WHERE id = ?').run(id);
  },
};

// ---- Events ----
export const eventsRepo = {
  add(e: PrinterEvent): PrinterEvent {
    const info = db.prepare(
      `INSERT INTO events (printer_id, printer_name, type, severity, title, message, filename, action_taken, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(e.printerId, e.printerName, e.type, e.severity, e.title, e.message,
          e.filename ?? null, e.actionTaken ?? null, e.createdAt);
    return { ...e, id: Number(info.lastInsertRowid) };
  },
  /** Time of the first failure warning on a printer within [from, to], if any. */
  firstFailure(printerId: number, from: number, to: number): number | null {
    const r = db.prepare(`SELECT min(created_at) AS t FROM events WHERE printer_id = ? AND created_at BETWEEN ? AND ?
                          AND type IN ('ai_failure', 'jam_suspected', 'reference_mismatch', 'klipper_error', 'filament_runout')`)
      .get(printerId, from, to) as any;
    return r?.t ?? null;
  },
  setPushResult(id: number, result: string) {
    db.prepare('UPDATE events SET push_result = ? WHERE id = ?').run(result.slice(0, 500), id);
  },
  recent(limit = 100): PrinterEvent[] {
    return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map((r: any) => ({
      id: r.id, printerId: r.printer_id, printerName: r.printer_name, type: r.type,
      severity: r.severity, title: r.title, message: r.message, filename: r.filename,
      actionTaken: r.action_taken, createdAt: r.created_at, pushResult: r.push_result ?? null,
    }));
  },
};

// ---- Push subscriptions ----
export const pushRepo = {
  all(): { endpoint: string; keys: { p256dh: string; auth: string } }[] {
    return db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all().map((r: any) => ({
      endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth },
    }));
  },
  upsert(endpoint: string, p256dh: string, auth: string) {
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`
    ).run(endpoint, p256dh, auth, Date.now());
  },
  remove(endpoint: string) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },
};

// ---- KV (VAPID keys, misc) ----
export const kv = {
  get(key: string): string | undefined {
    const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
    return r?.value;
  },
  set(key: string, value: string) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  },
};

// ---- Prints + telemetry (training dataset) ----
export const printsRepo = {
  start(printerId: number, filename: string | null, snapshotDir: string): number {
    const info = db.prepare(
      'INSERT INTO prints (printer_id, filename, started_at, snapshot_dir) VALUES (?, ?, ?, ?)'
    ).run(printerId, filename, Date.now(), snapshotDir);
    return Number(info.lastInsertRowid);
  },
  end(printId: number, outcome: string) {
    const row = db.prepare('SELECT started_at FROM prints WHERE id = ?').get(printId) as any;
    const started = row?.started_at ?? Date.now();
    db.prepare('UPDATE prints SET ended_at=?, outcome=?, duration_sec=? WHERE id=?')
      .run(Date.now(), outcome, Math.round((Date.now() - started) / 1000), printId);
  },
  addTelemetry(printId: number, s: {
    progress: number; bedTemp: number; bedTarget: number; extruderTemp: number;
    extruderTarget: number; printDuration: number; filamentDetected: boolean | null | undefined;
    snapshot?: string | null;
    extruderPower?: number | null; extruderVelocity?: number | null; z?: number | null; fan0?: number | null; samples?: number | null;
  }) {
    db.prepare(
      `INSERT INTO telemetry (print_id, t, progress, bed_temp, bed_target, extruder_temp, extruder_target, print_duration, filament_detected, snapshot,
                              extruder_power, extruder_velocity, z, fan0, samples)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(printId, Date.now(), s.progress, s.bedTemp, s.bedTarget, s.extruderTemp, s.extruderTarget,
          s.printDuration, s.filamentDetected == null ? null : (s.filamentDetected ? 1 : 0), s.snapshot ?? null,
          s.extruderPower ?? null, s.extruderVelocity ?? null, s.z ?? null, s.fan0 ?? null, s.samples ?? null);
  },
  recent(limit = 50) {
    return db.prepare('SELECT * FROM prints ORDER BY id DESC LIMIT ?').all(limit);
  },
  /** The print currently being tracked on a printer (not yet ended), if any. */
  open(printerId: number): { id: number; snapshot_dir: string | null; filename: string | null } | undefined {
    return db.prepare('SELECT id, snapshot_dir, filename FROM prints WHERE printer_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(printerId) as any;
  },
  /**
   * Older builds opened a new row on every backend restart mid-print, leaving the
   * earlier fragments open forever. Close each open row that has a newer row on the
   * same printer, as 'continued' (ended when the next fragment started), so the
   * fragments of one print can be stitched back together for training.
   */
  closeFragments(): number {
    const rows = db.prepare('SELECT id, printer_id, started_at, filename FROM prints WHERE ended_at IS NULL ORDER BY printer_id, id').all() as any[];
    let n = 0;
    for (const r of rows) {
      const next = db.prepare('SELECT started_at, filename FROM prints WHERE printer_id = ? AND id > ? ORDER BY id LIMIT 1').get(r.printer_id, r.id) as any;
      if (!next) continue;
      // Same file next = the same print split by a restart; otherwise a separate print whose end we missed.
      const outcome = next.filename === r.filename ? 'continued' : 'unknown';
      db.prepare(`UPDATE prints SET ended_at = ?, outcome = ?, duration_sec = ? WHERE id = ?`)
        .run(next.started_at, outcome, Math.round((next.started_at - r.started_at) / 1000), r.id);
      n++;
    }
    return n;
  },
  /**
   * Stopped prints (cancelled / error) without a failure label, newest first. Restart
   * fragments are marked 'continued', so only the final row of a stopped print matches.
   */
  unlabelled(sinceMs: number, limit = 50) {
    return db.prepare(`
      SELECT p.id, p.printer_id AS printerId, pr.name AS printerName, p.filename, p.outcome,
             p.started_at AS startedAt, p.ended_at AS endedAt
      FROM prints p JOIN printers pr ON pr.id = p.printer_id
      WHERE p.outcome IN ('cancelled', 'error') AND p.failure_reason IS NULL AND p.ended_at >= ?
      ORDER BY p.ended_at DESC LIMIT ?`).all(sinceMs, limit);
  },
  /** Recent finished prints of any outcome (for labelling a completed print as bad, too). */
  finished(sinceMs: number, limit = 50) {
    return db.prepare(`
      SELECT p.id, p.printer_id AS printerId, pr.name AS printerName, p.filename, p.outcome, p.started_at AS startedAt,
             p.ended_at AS endedAt, p.failure_reason AS reason, p.failure_note AS note
      FROM prints p JOIN printers pr ON pr.id = p.printer_id
      WHERE p.outcome IN ('completed', 'cancelled', 'error') AND p.ended_at >= ?
      ORDER BY p.ended_at DESC LIMIT ?`).all(sinceMs, limit);
  },
  label(id: number, reason: string, note: string | null) {
    return db.prepare('UPDATE prints SET failure_reason = ?, failure_note = ?, labelled_at = ? WHERE id = ?')
      .run(reason, note, Date.now(), id).changes > 0;
  },
  get(id: number): { id: number; snapshot_dir: string | null } | undefined {
    return db.prepare('SELECT id, snapshot_dir FROM prints WHERE id = ?').get(id) as any;
  },
  /** Every row printed from a file, in order (for building reference runs). */
  byFile(filename: string): { id: number; printer_id: number; outcome: string | null; failure_reason: string | null; started_at: number; ended_at: number | null }[] {
    return db.prepare(`SELECT id, printer_id, outcome, failure_reason, started_at, ended_at FROM prints
                       WHERE filename = ? ORDER BY printer_id, id`).all(filename) as any;
  },
  /** Saved frames (progress + absolute-ish path parts) of the given print rows, oldest first. */
  frames(printIds: number[]): { t: number; progress: number; dir: string; file: string }[] {
    if (!printIds.length) return [];
    return db.prepare(`SELECT t.t, t.progress, p.snapshot_dir AS dir, t.snapshot AS file FROM telemetry t JOIN prints p ON p.id = t.print_id
                       WHERE t.print_id IN (${printIds.map(() => '?').join(',')}) AND t.snapshot IS NOT NULL AND t.progress IS NOT NULL
                       ORDER BY t.t`).all(...printIds) as any;
  },
  /** Progress of a run at time t (last telemetry row at or before t). */
  progressAt(printIds: number[], t: number): number | null {
    if (!printIds.length) return null;
    const r = db.prepare(`SELECT progress FROM telemetry WHERE print_id IN (${printIds.map(() => '?').join(',')}) AND t <= ?
                          ORDER BY t DESC LIMIT 1`).get(...printIds, t) as any;
    return r?.progress ?? null;
  },
  /** Heater power / target / part fan rows of a print since `t` (jam detection). */
  powerSince(printId: number, t: number): { t: number; power: number | null; target: number | null; fan0: number | null }[] {
    return db.prepare(`SELECT t, extruder_power AS power, extruder_target AS target, fan0 FROM telemetry
                       WHERE print_id = ? AND t >= ? AND samples > 0 ORDER BY t`).all(printId, t) as any;
  },
  /** End every other open row on a printer (a new print started, so they're over). */
  closeOthers(printerId: number, keepId: number, outcome = 'unknown') {
    db.prepare('UPDATE prints SET ended_at = ?, outcome = ? WHERE printer_id = ? AND ended_at IS NULL AND id != ?')
      .run(Date.now(), outcome, printerId, keepId);
  },
};

// ---- AI verdicts ----
export interface AiCheck {
  printerId: number; printId: number | null; t: number; snapshot: string | null;
  source: 'detector' | 'vlm' | 'reference';
  assessment: string; confidence: number | null; reason: string | null; defects: string[];
  progress: number | null; model: string | null; latencyMs: number | null; raw: string | null;
  score?: number | null; risk?: number | null;
}

export const aiRepo = {
  add(c: AiCheck) {
    db.prepare(
      `INSERT INTO ai_checks (printer_id, print_id, t, snapshot, source, assessment, confidence, reason, defects, progress, model, latency_ms, raw, score, risk)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(c.printerId, c.printId, c.t, c.snapshot, c.source, c.assessment, c.confidence, c.reason,
          JSON.stringify(c.defects || []), c.progress, c.model, c.latencyMs, c.raw, c.score ?? null, c.risk ?? null);
  },
  recent(printerId?: number, limit = 50) {
    const rows = printerId
      ? db.prepare('SELECT * FROM ai_checks WHERE printer_id = ? ORDER BY id DESC LIMIT ?').all(printerId, limit)
      : db.prepare('SELECT * FROM ai_checks ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r: any) => ({ ...r, defects: (() => { try { return JSON.parse(r.defects || '[]'); } catch { return []; } })() }));
  },
};
