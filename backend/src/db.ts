import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { Printer, PrinterEvent } from './types.js';

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
  recent(limit = 100): PrinterEvent[] {
    return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map((r: any) => ({
      id: r.id, printerId: r.printer_id, printerName: r.printer_name, type: r.type,
      severity: r.severity, title: r.title, message: r.message, filename: r.filename,
      actionTaken: r.action_taken, createdAt: r.created_at,
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
  }) {
    db.prepare(
      `INSERT INTO telemetry (print_id, t, progress, bed_temp, bed_target, extruder_temp, extruder_target, print_duration, filament_detected, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(printId, Date.now(), s.progress, s.bedTemp, s.bedTarget, s.extruderTemp, s.extruderTarget,
          s.printDuration, s.filamentDetected == null ? null : (s.filamentDetected ? 1 : 0), s.snapshot ?? null);
  },
  recent(limit = 50) {
    return db.prepare('SELECT * FROM prints ORDER BY id DESC LIMIT ?').all(limit);
  },
  /** The print currently being tracked on a printer (not yet ended), if any. */
  open(printerId: number): { id: number; snapshot_dir: string | null } | undefined {
    return db.prepare('SELECT id, snapshot_dir FROM prints WHERE printer_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(printerId) as any;
  },
};

// ---- AI verdicts ----
export interface AiCheck {
  printerId: number; printId: number | null; t: number; snapshot: string | null;
  source: 'detector' | 'vlm';
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
