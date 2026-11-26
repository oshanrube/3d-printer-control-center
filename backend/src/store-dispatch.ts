// Store-driven printing, phase 3: load planned plates onto printers, follow them, and on the
// owner's "Complete" turn printed parts into store stock.
//
// Safety: both master switches start OFF.
//  - Auto-load (kv store:autoload): off = plan only, nothing is sent to printers.
//  - Store writes (kv store:writes): off = dry run, store stock changes are logged, not made.
// Load-only (owner's rule): the plate's file is put on the printer (reused if the same file is
// already there), other files are left alone, and printing is started by the owner.
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { config } from './config.js';
import { db, kv } from './db.js';
import type { Fleet } from './fleet.js';
import type { LiveState, PrinterEvent } from './types.js';
import { HISTORY_KEY, inventoryLive, syncStore } from './inventory.js';
import { activeJob, autoStartOn, colourMap, markBedClear, plan, readiness, takeParts } from './store-jobs.js';
import { captureForDataset } from './camera.js';
import { looksClear } from './bed-clear.js';
import { reportPrinted } from './store.js';
import { listGcodes, printState, startPrint, uploadGcode } from './printer-files.js';
import type { StoreOption } from './store.js';

db.exec(`
CREATE TABLE IF NOT EXISTS store_updates (     -- every store stock change, made or (dry run) intended
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, product_id INTEGER NOT NULL, combination_id INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '', delta INTEGER NOT NULL, before_qty INTEGER, after_qty INTEGER,
  dry_run INTEGER NOT NULL, error TEXT, parts TEXT NOT NULL DEFAULT ''
);
`);

const setting = (k: string) => kv.get(k) === '1';
export const autoLoad = () => setting('store:autoload');

type Report = (e: Omit<PrinterEvent, 'createdAt'>) => unknown;
const IDLE = ['standby', 'complete', 'cancelled'];

// ---- Camera bed-clear watcher: auto-advance the queue when a camera-confirmed clear bed appears ----
const BED_CLEAR_EVERY_MS = 30_000;
const CLEAR_CONFIRMATIONS = 2;            // consecutive clear reads (~60 s) before trusting it
const clearStreak = new Map<number, number>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function watchBedClear(fleet: Fleet, report: Report): Promise<void> {
  if (!autoLoad()) return;                                           // queue must be running at all
  const states = fleet.getStates();
  if (!states.some(s => autoStartOn(s.printerId))) return;           // no printer opted in
  // Only cycle the camera/light when there's actually work waiting for a printer.
  let pending = false;
  try { pending = plan(fleet).jobs.some(j => !j.printer); } catch { pending = false; }
  if (!pending) { clearStreak.clear(); return; }
  for (const s of states) {
    const id = s.printerId;
    if (!autoStartOn(id)) { clearStreak.delete(id); continue; }
    const r = readiness(fleet, s, colourMap());
    // Candidate: online, idle (not preparing), available, filament known, no job, has a reference,
    // and the bed isn't already confirmed clear.
    if (!r.online || r.bedClear || !r.available || !r.hasBedRef || activeJob(id)
        || !IDLE.includes(s.state) || s.preparing || !r.spools.length || s.filamentDetected === false) {
      clearStreak.delete(id); continue;
    }
    // Turn the light on only for the capture, then put it back as it was: a printer waiting with a
    // yet-to-be-cleared bed used to get its light re-lit every 30 s here, fighting the idle-off
    // watchdog forever (the light never went off and idle_off events spammed).
    const lightWasOff = !((s.peripherals?.light ?? 0) > 0);
    const restoreLight = () => { if (lightWasOff) fleet.setLight(id, false).catch(() => {}); };
    try {
      await fleet.setLight(id, true).catch(() => {});               // need light to see the bed
      await sleep(700);
      const shot = await captureForDataset(fleet.client(id)!.printer);
      if (!shot) { restoreLight(); clearStreak.delete(id); continue; }
      const clear = looksClear(id, shot.body);
      const n = clear ? (clearStreak.get(id) ?? 0) + 1 : 0;
      clearStreak.set(id, n);
      if (n >= CLEAR_CONFIRMATIONS) {
        clearStreak.delete(id);
        markBedClear(id);
        console.log(`[bed-clear] ${r.name}: bed confirmed clear by camera (${CLEAR_CONFIRMATIONS}x); advancing queue`);
        await syncStore('bed-clear');
        await dispatch(fleet, report, 'camera bed-clear');           // loads + auto-starts; print-start manages the light
      } else {
        restoreLight();   // still waiting for a clear bed: don't leave the light on while idle
      }
    } catch (e: any) { restoreLight(); clearStreak.delete(id); console.warn(`[bed-clear] check failed for ${id}: ${e?.message || e}`); }
  }
}


function setJob(id: number, patch: Record<string, any>) {
  for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE store_jobs SET ${k} = ? WHERE id = ?`).run(v, id);
}
const jobRow = (id: number) => db.prepare('SELECT * FROM store_jobs WHERE id = ?').get(id) as any;
const partName = (id: number) => (db.prepare('SELECT name FROM parts WHERE id = ?').get(id) as any)?.name ?? `part ${id}`;
const describe = (j: any) => `${partName(j.part_id)} (${j.units} unit${j.units === 1 ? '' : 's'}${j.colour ? `, ${j.colour}` : ''})`;

// ---------------------------------------------------------------------------
// Loading

let dispatching: Promise<void> | null = null;
let dispatchStarted = 0;
const DISPATCH_STUCK_MS = 15 * 60_000;   // longer than any upload: the lock is released and logged

/** Load planned plates onto ready printers (only with auto-load on). One run at a time. */
export function dispatch(fleet: Fleet, report: Report, reason: string): Promise<void> {
  if (!autoLoad()) return Promise.resolve();
  // The store's Printed stock module decides what's needed. Until it's live (parts counted,
  // quantities checked by the owner) its numbers aren't trusted for loading printers.
  if (!inventoryLive()) { console.log(`[store] dispatch (${reason}): waiting, the store's Printed stock is in log-only mode`); return Promise.resolve(); }
  if (dispatching && Date.now() - dispatchStarted > DISPATCH_STUCK_MS) {
    console.warn(`[store] dispatch run from ${new Date(dispatchStarted).toISOString()} never finished: releasing it`);
    dispatching = null;
  }
  if (dispatching) return dispatching;
  const started = dispatchStarted = Date.now();
  const run: Promise<void> = (async () => {
    // Yield first. Without it, a run with nothing to load finished synchronously, cleared the
    // lock before it was set, and the finished promise stayed as the lock: every later dispatch
    // (timer, printer free, Load now) did nothing until a restart (Luffy, 2026-11-17).
    await null;
    try {
      const p = plan(fleet);
      const assigned = p.jobs.filter(j => j.printer && j.file);
      console.log(`[store] dispatch (${reason}): ${assigned.length ? assigned.map(j => `${j.part} -> ${j.printer!.name}`).join(', ') : 'no plate has a ready printer'}`);
      for (const job of p.jobs) {
        if (!job.printer || !job.file) continue;
        await loadOne(fleet, report, job, reason).catch(e => console.warn(`[store] loading failed: ${e?.message || e}`));
      }
    } finally { if (dispatchStarted === started) dispatching = null; }
  })();
  dispatching = run;
  return run;
}

async function loadOne(fleet: Fleet, report: Report, job: ReturnType<typeof plan>['jobs'][number], reason: string) {
  const printer = fleet.client(job.printer!.id)?.printer;
  if (!printer) return console.log(`[store] skip: printer ${job.printer!.id} unknown`);
  if (activeJob(printer.id)) return console.log(`[store] skip ${printer.name}: already has job ${activeJob(printer.id).id}`);
  const file = db.prepare('SELECT * FROM part_files WHERE id = ?').get(job.file!.id) as any;
  if (!file) return console.log(`[store] skip ${printer.name}: file ${job.file!.id} gone`);
  // Ask the printer itself, not the cache: never touch a printer that's busy.
  const state = await printState(printer);
  if (!IDLE.includes(state)) return console.log(`[store] skip ${printer.name}: printer says ${state}`);
  const name = basename(file.filename).replace(/[^\w.() -]/g, '_');
  // An any-colour plate prints in whatever is loaded: record that colour, so the plate also counts
  // for items that need it (two White nose plates were planned twice, 2026-11-19).
  const colour = job.colour ?? loadedColour(fleet, printer.id);
  const info = db.prepare(`INSERT INTO store_jobs (part_id, file_id, colour, units, printer_id, printer_file, status, for_items, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'loading', ?, ?)`).run(job.partId, file.id, colour, job.unitsPerPlate, printer.id, name,
    JSON.stringify(job.forItems), Date.now());
  const id = Number(info.lastInsertRowid);
  try {
    // Reuse the copy already on the printer when it's the same file (same name and size);
    // otherwise upload it. Other files on the printer are left alone (owner's call, 2026-11-17).
    const onPrinter = (await listGcodes(printer)).find(f => f.path === name);
    const reused = !!onPrinter && onPrinter.size === file.size;
    if (!reused) await uploadGcode(printer, name, readFileSync(join(config.dataDir, file.path)));
    const how = reused ? 'already on the printer' : onPrinter ? 'uploaded (replaced an older copy)' : 'uploaded';
    setJob(id, { status: 'loaded', loaded_at: Date.now(), note: how });
    console.log(`[store] job ${id}: ${name} on ${printer.name} (${reason}): ${how}`);
    if (autoStartOn(printer.id)) {
      // The camera confirmed the bed is clear (that's why this printer was ready), so start it.
      // The printer's own pre-print check (foreign-object scan on the K2) is a last backstop.
      await startPrint(printer, name);
      setJob(id, { note: `${how}; auto-started` });
      report({ printerId: printer.id, printerName: printer.name, type: 'store_job', severity: 'warning',
        title: `📦 ${printer.name}: auto-started ${partName(job.partId)}`,
        message: `${describe(jobRow(id))} for ${job.forItems.join(', ')} was loaded (${how}) and started automatically after the camera confirmed the bed was clear.`,
        filename: name, actionTaken: 'auto-started' });
    } else {
      report({ printerId: printer.id, printerName: printer.name, type: 'store_job', severity: 'warning',
        title: `📦 ${printer.name}: ${partName(job.partId)} loaded`,
        message: `${describe(jobRow(id))} for ${job.forItems.join(', ')} is ready on the printer (${jobRow(id).note}). Clear the bed and start “${name}”.`,
        filename: name, actionTaken: 'loaded' });
    }
  } catch (e: any) {
    setJob(id, { status: 'failed', ended_at: Date.now(), note: `loading failed: ${e?.message || e}` });
    report({ printerId: printer.id, printerName: printer.name, type: 'store_job', severity: 'warning',
      title: `📦 ${printer.name}: couldn't load ${partName(job.partId)}`, message: String(e?.message || e), filename: name, actionTaken: null });
  }
}

// ---------------------------------------------------------------------------
// Following a job through the printer's states

const idleSince = new Map<number, number>();   // printing jobs whose printer came back idle (power cut)

/**
 * A print started by hand from a part's G-code file (not loaded by the queue) is adopted as a
 * store job, so it counts as parts on the way and gets Complete / Failed like any other
 * (owner, 2026-11-19: "count them as successful"). Colour = the single spool the printer has
 * loaded (several, e.g. a K2 CFS: any colour).
 */
/** The colour name of the one spool a printer has loaded ('' when unknown or several, e.g. a K2 CFS). */
function loadedColour(fleet: Fleet, printerId: number): string {
  const s = fleet.getStates().find(x => x.printerId === printerId);
  if (!s) return '';
  const r = readiness(fleet, s, colourMap());
  return r.spools.length === 1 ? (r.spools[0].colourName || '') : '';
}

function adopt(fleet: Fleet, report: Report, s: LiveState, file: string) {
  const f = (db.prepare('SELECT * FROM part_files').all() as any[])
    .find(x => basename(x.filename) === file || basename(x.filename).replace(/[^\w.() -]/g, '_') === file);
  if (!f) return;
  // Not again for this print: a job for this file that ended during it (marked Failed while still
  // printing, or the queue's own job) would otherwise be re-created at once.
  const printStart = Date.now() - Math.max(0, s.totalDuration || 0) * 1000 - 60_000;
  if (db.prepare('SELECT 1 FROM store_jobs WHERE printer_id = ? AND printer_file = ? AND created_at > ?').get(s.printerId, file, printStart)) return;
  const colour = loadedColour(fleet, s.printerId);
  const name = fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
  const info = db.prepare(`INSERT INTO store_jobs (part_id, file_id, colour, units, printer_id, printer_file, status, for_items, created_at, loaded_at, started_at, note)
    VALUES (?, ?, ?, ?, ?, ?, 'printing', '[]', ?, ?, ?, 'started by hand')`).run(f.part_id, f.id, colour, Math.max(1, f.units_per_plate), s.printerId, file, Date.now(), Date.now(), Date.now());
  const part = partName(f.part_id);
  console.log(`[store] job ${info.lastInsertRowid}: adopted ${file} on ${name} (started by hand, ${f.units_per_plate}x ${part}${colour ? ` ${colour}` : ''})`);
  report({ printerId: s.printerId, printerName: name, type: 'store_job', severity: 'info',
    title: `📦 ${name}: ${part} started by hand`,
    message: `${f.units_per_plate}× ${part}${colour ? ` (${colour})` : ''} now counts as on the way. When it finishes, press Complete (adds them to the store) or Failed.`,
    filename: file, actionTaken: 'adopted' });
}

export function track(fleet: Fleet, report: Report, s: LiveState, prev: string | undefined) {
  const j = activeJob(s.printerId);
  if (!j && s.online && s.state === 'printing' && s.filename) { adopt(fleet, report, s, basename(s.filename)); return; }
  if (!j || !s.online || s.state === 'offline') return;
  const name = fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
  const file = s.filename ? basename(s.filename) : '';
  if (j.status === 'loaded' && s.state === 'printing') {
    if (file === j.printer_file) { setJob(j.id, { status: 'printing', started_at: Date.now() }); return; }
    setJob(j.id, { status: 'cancelled', ended_at: Date.now(), note: `the printer started another file (${file})` });
    return;
  }
  if (j.status !== 'printing') return;
  // After a power cut the printer comes back idle (prev 'offline') and the print can still be
  // resumed from its screen, so that alone isn't a failure. If it stays idle for an hour,
  // the print was abandoned.
  if (IDLE.includes(s.state) && prev === 'offline') { idleSince.set(j.id, Date.now()); return; }
  if (IDLE.includes(s.state) && idleSince.has(j.id)) {
    if (Date.now() - idleSince.get(j.id)! > 60 * 60_000) {
      idleSince.delete(j.id);
      setJob(j.id, { status: 'failed', ended_at: Date.now(), note: 'not resumed within an hour of the printer restarting' });
    }
    return;
  }
  idleSince.delete(j.id);
  if (s.state === 'complete' && file === j.printer_file) {
    setJob(j.id, { status: 'printed', ended_at: Date.now() });
    report({ printerId: s.printerId, printerName: name, type: 'store_job', severity: 'info',
      title: `📦 ${name}: ${partName(j.part_id)} printed`,
      message: `${describe(j)} finished. Check it, then press Complete (adds it to stock) or Failed (prints it again).`,
      filename: file, actionTaken: null });
  } else if (['cancelled', 'error'].includes(s.state) || (s.state === 'standby' && prev && ['printing', 'paused'].includes(prev))) {
    setJob(j.id, { status: 'failed', ended_at: Date.now(), note: `print ${s.state}` });
    report({ printerId: s.printerId, printerName: name, type: 'store_job', severity: 'warning',
      title: `📦 ${name}: ${partName(j.part_id)} failed`,
      message: `${describe(j)} ended (${s.state}). It goes back in the queue, preferably on another printer.`,
      filename: file, actionTaken: 'requeued' });
  }
}

// ---------------------------------------------------------------------------
// Complete -> the store's Printed stock (parts on hand); it sets the store quantities itself.

async function complete(j: any, fleet: Fleet, report: Report) {
  const printer = fleet.client(j.printer_id)?.printer.name || `Printer ${j.printer_id}`;
  const r = await reportPrinted({ partId: j.part_id, colour: j.colour || '', qty: j.units, ref: `job:${j.id}`,
    note: `${printer}: ${j.units}x ${partName(j.part_id)}${j.colour ? ` ${j.colour}` : ''} (job ${j.id})` });
  const changed = r.changes.map(c => `${c.reference} ${c.before}→${c.after}`).join(', ');
  const note = r.already ? 'already in the store' : r.changes.length
    ? `store ${r.changes[0].written ? 'now' : 'would be (log only)'}: ${changed}` : 'added to parts on hand';
  setJob(j.id, { status: 'completed', ended_at: j.ended_at ?? Date.now(), note: note.slice(0, 500) });
  if (r.changes.length) report({ printerId: j.printer_id, printerName: printer, type: 'store_job', severity: 'info',
    title: `📦 ${partName(j.part_id)} ×${j.units} added to the store`, message: `${j.units} on hand. ${note}.`, filename: j.printer_file, actionTaken: 'completed' });
  console.log(`[store] job ${j.id} completed: ${note}`);
}

// The owner acknowledged a finished/cancelled print on the printer's own screen (the "OK" in the
// dialog). Klipper reports that as complete|cancelled -> standby. Since the owner clears the bed
// before tapping OK, mirror the dashboard "Bed cleared" button: mark the bed clear and advance the
// queue (dispatch still checks full readiness, so nothing loads onto a busy printer or one holding
// a job). We deliberately do NOT re-teach the empty-bed reference (a dashboard-only action) and NOT
// auto-"Complete" the finished job (confirming parts into store stock stays manual).
async function onFinishAck(fleet: Fleet, report: Report, s: LiveState) {
  if (!autoLoad()) return;                         // queue off entirely
  const id = s.printerId;
  const r = readiness(fleet, s, colourMap());
  if (!r.available) return;                        // printer isn't taking store jobs
  markBedClear(id);
  fleet.refreshSpools(id);
  console.log(`[ack] ${r.name}: finished-print dialog acknowledged on the screen -> bed marked clear; checking the queue`);
  await syncStore('finish-ack');
  await dispatch(fleet, report, 'printer finish OK');
}

// ---------------------------------------------------------------------------
// Routes and triggers

export function registerStoreDispatch(app: FastifyInstance, fleet: Fleet, report: Report) {
  // An upload cut off by an app restart leaves its job "loading" forever, which also blocks
  // that printer (2026-11-17, Sanji). Mark such jobs interrupted; they are planned again.
  const stale = db.prepare(`UPDATE store_jobs SET status = 'cancelled', ended_at = ?, note = 'upload interrupted by an app restart' WHERE status = 'loading'`).run(Date.now());
  // Jobs under way recorded as "any colour": they print in the loaded filament's colour (see loadOne).
  setTimeout(() => {
    for (const j of db.prepare(`SELECT id, printer_id FROM store_jobs WHERE colour = '' AND status IN ('loaded','printing','printed')`).all() as any[]) {
      const c = loadedColour(fleet, j.printer_id);
      if (c) { setJob(j.id, { colour: c }); console.log(`[store] job ${j.id}: colour set to ${c} (the filament loaded on that printer)`); }
    }
  }, 30_000);   // after the printers' spools are known
  if (stale.changes) console.log(`[store] ${stale.changes} interrupted upload(s) marked cancelled; they will be loaded again`);
  const prev = new Map<number, string>();
  fleet.on('state', (s: LiveState) => {
    const was = prev.get(s.printerId);
    track(fleet, report, s, was);
    // "OK" on the printer's own finished/cancelled dialog shows up as complete|cancelled -> standby
    // (verified 2026-11-24: only acknowledging the dialog leaves that state; a new print or restart
    // is the only other way out). The owner clears the bed before tapping OK, so treat it like the
    // dashboard "Bed cleared" button and advance the queue.
    if ((was === 'complete' || was === 'cancelled') && s.state === 'standby')
      onFinishAck(fleet, report, s).catch(e => console.warn('[ack]', e?.message || e));
    prev.set(s.printerId, s.state);
  });
  // Planning triggers (a printer became ready, Sync now, ...) end in a sync; load after it.
  const afterSync = () => syncStore('dispatch').then(() => dispatch(fleet, report, 'sync')).catch(() => {});
  setInterval(() => { if (autoLoad()) dispatch(fleet, report, 'periodic check').catch(() => {}); }, 5 * 60_000);
  setInterval(() => watchBedClear(fleet, report).catch(() => {}), BED_CLEAR_EVERY_MS);

  const jobsOut = () => {
    const rows = db.prepare(`SELECT * FROM store_jobs WHERE status IN ('loading','loaded','printing','printed') OR created_at > ? ORDER BY id DESC LIMIT 100`)
      .all(Date.now() - 7 * 86400e3) as any[];
    return rows.map(j => ({ id: j.id, part: partName(j.part_id), partId: j.part_id, colour: j.colour || null, units: j.units,
      printerId: j.printer_id, printer: fleet.client(j.printer_id)?.printer.name || `Printer ${j.printer_id}`, file: j.printer_file,
      status: j.status, note: j.note, forItems: JSON.parse(j.for_items || '[]'),
      createdAt: j.created_at, loadedAt: j.loaded_at, startedAt: j.started_at, endedAt: j.ended_at }));
  };
  // Store quantity changes, from the store's Printed stock history (refreshed on every sync).
  const updatesOut = () => ((JSON.parse(kv.get(HISTORY_KEY) || '{}').quantities ?? []) as any[]).slice(0, 50)
    .map(u => ({ id: Number(u.id), at: Date.parse(String(u.date_add).replace(' ', 'T') + '+05:30') || 0, reference: u.reference,
      delta: Number(u.qty_after) - Number(u.qty_before), before: Number(u.qty_before), after: Number(u.qty_after),
      dryRun: !Number(u.written), error: null, parts: u.reason }));
  const out = () => ({ autoLoad: autoLoad(), liveWrites: inventoryLive(), jobs: jobsOut(), updates: updatesOut() });

  app.get('/api/store/jobs', async () => out());

  app.post('/api/store/jobs/settings', async (req) => {
    const b = (req.body || {}) as any;
    if (b.autoLoad !== undefined) { kv.set('store:autoload', b.autoLoad ? '1' : '0'); if (b.autoLoad) afterSync(); }
    return out();
  });

  app.post('/api/store/dispatch', async () => { await syncStore('manual'); await dispatch(fleet, report, 'manual'); return out(); });

  const withJob = (h: (j: any) => Promise<any> | any) => async (req: any, reply: any) => {
    const j = jobRow(Number(req.params.id));
    if (!j) return reply.code(404).send({ error: 'Unknown job.' });
    try { const r = await h(j); if (r?.error) return reply.code(409).send(r); return out(); }
    catch (e: any) { return reply.code(409).send({ error: String(e?.message || e) }); }
  };

  app.post('/api/store/jobs/:id/complete', withJob(async j => {
    if (!['printed', 'printing'].includes(j.status)) return { error: `This job is ${j.status}: only a printed job can be completed.` };
    await complete(j, fleet, report);   // throws (job stays printed) if the store can't be reached
    afterSync();
  }));
  app.post('/api/store/jobs/:id/failed', withJob(j => {
    if (!['printed', 'printing', 'loaded'].includes(j.status)) return { error: `This job is ${j.status}.` };
    setJob(j.id, { status: 'failed', ended_at: Date.now(), note: 'marked failed by you' });
    afterSync();
  }));
  app.post('/api/store/jobs/:id/cancel', withJob(j => {
    if (!['loaded', 'loading'].includes(j.status)) return { error: 'Only a job that has not started can be cancelled.' };
    setJob(j.id, { status: 'cancelled', ended_at: Date.now(), note: 'cancelled by you' });
  }));
  app.post('/api/store/jobs/:id/start', withJob(async j => {
    if (j.status !== 'loaded') return { error: `This job is ${j.status}.` };
    const printer = fleet.client(j.printer_id)?.printer;
    if (!printer) return { error: 'The printer is not connected.' };
    const st = await printState(printer);
    if (!IDLE.includes(st)) return { error: `The printer is ${st}.` };
    await startPrint(printer, j.printer_file);
  }));
}
