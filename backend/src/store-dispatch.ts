// Store-driven printing, phase 3: load planned plates onto printers, follow them, and on the
// owner's "Complete" turn printed parts into store stock.
//
// Safety: both master switches start OFF.
//  - Auto-load (kv store:autoload): off = plan only, nothing is sent to printers.
//  - Store writes (kv store:writes): off = dry run, store stock changes are logged, not made.
// Load-only (owner's rule): files are uploaded and the printer's other G-code files deleted,
// but printing is started by the owner (screen, or ▶ Start on the card).
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { config } from './config.js';
import { db, kv } from './db.js';
import type { Fleet } from './fleet.js';
import type { LiveState, PrinterEvent } from './types.js';
import { itemColour, syncStore } from './inventory.js';
import { activeJob, plan, takeParts } from './store-jobs.js';
import { addStock } from './store.js';
import { deleteGcode, listGcodes, printState, startPrint, uploadGcode } from './printer-files.js';
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
export const liveWrites = () => setting('store:writes');

type Report = (e: Omit<PrinterEvent, 'createdAt'>) => unknown;
const IDLE = ['standby', 'complete', 'cancelled'];

function setJob(id: number, patch: Record<string, any>) {
  for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE store_jobs SET ${k} = ? WHERE id = ?`).run(v, id);
}
const jobRow = (id: number) => db.prepare('SELECT * FROM store_jobs WHERE id = ?').get(id) as any;
const partName = (id: number) => (db.prepare('SELECT name FROM parts WHERE id = ?').get(id) as any)?.name ?? `part ${id}`;
const describe = (j: any) => `${partName(j.part_id)} (${j.units} unit${j.units === 1 ? '' : 's'}${j.colour ? `, ${j.colour}` : ''})`;

// ---------------------------------------------------------------------------
// Loading

let dispatching: Promise<void> | null = null;

/** Load planned plates onto ready printers (only with auto-load on). One run at a time. */
export function dispatch(fleet: Fleet, report: Report, reason: string): Promise<void> {
  if (!autoLoad() || dispatching) return dispatching ?? Promise.resolve();
  dispatching = (async () => {
    try {
      const p = plan(fleet);
      for (const job of p.jobs) {
        if (!job.printer || !job.file) continue;
        await loadOne(fleet, report, job, reason).catch(e => console.warn(`[store] loading failed: ${e?.message || e}`));
      }
    } finally { dispatching = null; }
  })();
  return dispatching;
}

async function loadOne(fleet: Fleet, report: Report, job: ReturnType<typeof plan>['jobs'][number], reason: string) {
  const printer = fleet.client(job.printer!.id)?.printer;
  if (!printer || activeJob(printer.id)) return;
  const file = db.prepare('SELECT * FROM part_files WHERE id = ?').get(job.file!.id) as any;
  if (!file) return;
  // Ask the printer itself, not the cache: never touch a printer that's busy.
  const state = await printState(printer);
  if (!IDLE.includes(state)) return;
  const name = basename(file.filename).replace(/[^\w.() -]/g, '_');
  const info = db.prepare(`INSERT INTO store_jobs (part_id, file_id, colour, units, printer_id, printer_file, status, for_items, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'loading', ?, ?)`).run(job.partId, file.id, job.colour ?? '', job.unitsPerPlate, printer.id, name,
    JSON.stringify(job.forItems), Date.now());
  const id = Number(info.lastInsertRowid);
  try {
    await uploadGcode(printer, name, readFileSync(join(config.dataDir, file.path)));
    let removed = 0;
    for (const f of await listGcodes(printer)) {
      if (f.path === name) continue;
      await deleteGcode(printer, f.path).then(() => removed++).catch(e => console.warn(`[store] ${printer.name}: couldn't delete ${f.path}: ${e?.message || e}`));
    }
    setJob(id, { status: 'loaded', loaded_at: Date.now(), note: `${removed} other file(s) removed` });
    console.log(`[store] job ${id}: loaded ${name} on ${printer.name} (${reason}), removed ${removed} other file(s)`);
    report({ printerId: printer.id, printerName: printer.name, type: 'store_job', severity: 'warning',
      title: `📦 ${printer.name}: ${partName(job.partId)} loaded`,
      message: `Loaded ${describe(jobRow(id))} for ${job.forItems.join(', ')}. Clear the bed and start “${name}”.`,
      filename: name, actionTaken: 'loaded' });
  } catch (e: any) {
    setJob(id, { status: 'failed', ended_at: Date.now(), note: `loading failed: ${e?.message || e}` });
    report({ printerId: printer.id, printerName: printer.name, type: 'store_job', severity: 'warning',
      title: `📦 ${printer.name}: couldn't load ${partName(job.partId)}`, message: String(e?.message || e), filename: name, actionTaken: null });
  }
}

// ---------------------------------------------------------------------------
// Following a job through the printer's states

export function track(fleet: Fleet, report: Report, s: LiveState, prev: string | undefined) {
  const j = activeJob(s.printerId);
  if (!j || !s.online || s.state === 'offline') return;
  const name = fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
  const file = s.filename ? basename(s.filename) : '';
  if (j.status === 'loaded' && s.state === 'printing') {
    if (file === j.printer_file) { setJob(j.id, { status: 'printing', started_at: Date.now() }); return; }
    setJob(j.id, { status: 'cancelled', ended_at: Date.now(), note: `the printer started another file (${file})` });
    return;
  }
  if (j.status !== 'printing') return;
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
// Complete -> parts on hand -> assemble items -> store stock

function addParts(partId: number, colour: string, qty: number) {
  db.prepare(`INSERT INTO part_stock (part_id, colour, qty) VALUES (?, ?, ?)
    ON CONFLICT (part_id, colour) DO UPDATE SET qty = qty + excluded.qty`).run(partId, colour, qty);
}

/**
 * Turn complete sets of parts on hand into store stock for managed items below their minimum,
 * furthest below first. Live: parts are used up and the store's stock goes up by 1 per set.
 * Dry run: nothing changes; what would happen is logged in store_updates.
 */
export async function assemble(report: Report): Promise<number> {
  const live = liveWrites();
  const stock = new Map<string, number>();
  for (const r of db.prepare('SELECT * FROM part_stock').all() as any[]) stock.set(`${r.part_id}|${r.colour}`, r.qty);
  const recipes = db.prepare('SELECT * FROM recipes').all() as any[];
  const items = (db.prepare('SELECT * FROM store_items WHERE enabled = 1 AND in_store = 1 AND min_qty > store_qty').all() as any[])
    .sort((a, b) => (b.min_qty - b.store_qty) / b.min_qty - (a.min_qty - a.store_qty) / a.min_qty);
  let made = 0;
  for (const it of items) {
    const recipe = recipes.filter(r => r.product_id === it.product_id && r.combination_id === it.combination_id);
    if (!recipe.length) continue;
    const colour = itemColour(JSON.parse(it.options_json || '[]') as StoreOption[], it.default_colour, it.product_id);
    let qty = it.store_qty;
    while (qty < it.min_qty) {
      // Take a full set on a copy first: only commit it if every part is there.
      const trial = new Map(stock);
      const used = recipe.map(r => ({ r, ...takeParts(trial, r.part_id, colour, r.qty) }));
      if (used.some(u => u.taken < u.r.qty)) break;
      for (const [k, v] of trial) stock.set(k, v);
      const parts = used.map(u => u.from.map(([c, n]) => `${n}× ${partName(u.r.part_id)}${c ? ` ${c}` : ''}`).join(', ')).join(', ');
      if (!live) {
        db.prepare(`INSERT INTO store_updates (at, product_id, combination_id, reference, delta, before_qty, after_qty, dry_run, parts) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?)`)
          .run(Date.now(), it.product_id, it.combination_id, it.reference, qty, qty + 1, parts);
        qty++; made++; continue;
      }
      try {
        const { before, after } = await addStock(it.product_id, it.combination_id, 1);
        db.transaction(() => {
          for (const u of used) for (const [c, n] of u.from) db.prepare('UPDATE part_stock SET qty = qty - ? WHERE part_id = ? AND colour = ?').run(n, u.r.part_id, c);
          db.prepare('UPDATE store_items SET store_qty = ? WHERE product_id = ? AND combination_id = ?').run(after, it.product_id, it.combination_id);
          db.prepare(`INSERT INTO store_updates (at, product_id, combination_id, reference, delta, before_qty, after_qty, dry_run, parts) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)`)
            .run(Date.now(), it.product_id, it.combination_id, it.reference, before, after, parts);
        })();
        qty = after; made++;
      } catch (e: any) {
        db.prepare(`INSERT INTO store_updates (at, product_id, combination_id, reference, delta, dry_run, error, parts) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`)
          .run(Date.now(), it.product_id, it.combination_id, it.reference, String(e?.message || e), parts);
        report({ printerId: 0, printerName: 'Store', type: 'store_job', severity: 'warning', title: `📦 Couldn't update ${it.reference} in the store`,
          message: String(e?.message || e), filename: null, actionTaken: null });
        return made;
      }
    }
  }
  if (made) console.log(`[store] assembled ${made} item(s) (${live ? 'live' : 'dry run'})`);
  return made;
}

// ---------------------------------------------------------------------------
// Routes and triggers

export function registerStoreDispatch(app: FastifyInstance, fleet: Fleet, report: Report) {
  // An upload cut off by an app restart leaves its job "loading" forever, which also blocks
  // that printer (2026-11-17, Sanji). Mark such jobs interrupted; they are planned again.
  const stale = db.prepare(`UPDATE store_jobs SET status = 'cancelled', ended_at = ?, note = 'upload interrupted by an app restart' WHERE status = 'loading'`).run(Date.now());
  if (stale.changes) console.log(`[store] ${stale.changes} interrupted upload(s) marked cancelled; they will be loaded again`);
  const prev = new Map<number, string>();
  fleet.on('state', (s: LiveState) => {
    track(fleet, report, s, prev.get(s.printerId));
    prev.set(s.printerId, s.state);
  });
  // Planning triggers (a printer became ready, Sync now, ...) end in a sync; load after it.
  const afterSync = () => syncStore('dispatch').then(() => dispatch(fleet, report, 'sync')).catch(() => {});
  setInterval(() => { if (autoLoad()) dispatch(fleet, report, 'periodic check').catch(() => {}); }, 5 * 60_000);

  const jobsOut = () => {
    const rows = db.prepare(`SELECT * FROM store_jobs WHERE status IN ('loading','loaded','printing','printed') OR created_at > ? ORDER BY id DESC LIMIT 100`)
      .all(Date.now() - 7 * 86400e3) as any[];
    return rows.map(j => ({ id: j.id, part: partName(j.part_id), partId: j.part_id, colour: j.colour || null, units: j.units,
      printerId: j.printer_id, printer: fleet.client(j.printer_id)?.printer.name || `Printer ${j.printer_id}`, file: j.printer_file,
      status: j.status, note: j.note, forItems: JSON.parse(j.for_items || '[]'),
      createdAt: j.created_at, loadedAt: j.loaded_at, startedAt: j.started_at, endedAt: j.ended_at }));
  };
  const updatesOut = () => (db.prepare('SELECT * FROM store_updates ORDER BY id DESC LIMIT 50').all() as any[])
    .map(u => ({ id: u.id, at: u.at, reference: u.reference, delta: u.delta, before: u.before_qty, after: u.after_qty,
      dryRun: !!u.dry_run, error: u.error, parts: u.parts }));
  const out = () => ({ autoLoad: autoLoad(), liveWrites: liveWrites(), jobs: jobsOut(), updates: updatesOut() });

  app.get('/api/store/jobs', async () => out());

  app.post('/api/store/jobs/settings', async (req) => {
    const b = (req.body || {}) as any;
    if (b.autoLoad !== undefined) { kv.set('store:autoload', b.autoLoad ? '1' : '0'); if (b.autoLoad) afterSync(); }
    if (b.liveWrites !== undefined) kv.set('store:writes', b.liveWrites ? '1' : '0');
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
    setJob(j.id, { status: 'completed', ended_at: j.ended_at ?? Date.now() });
    addParts(j.part_id, j.colour, j.units);
    await assemble(report);
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
