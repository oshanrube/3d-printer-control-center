// Store-driven printing, phase 1: the store's catalogue, printed parts, recipes and G-code
// library. Read-only towards the store (stock writes come in a later phase).
//
// Model: a store item (product + combination) is made of printed parts (recipe: part x qty).
// Parts have a G-code file per printer model (Creality's model code: K1C, K1, F008 = K2 Plus)
// and a units-per-plate count. Parts on hand are shared by every item that uses them.
import type { FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { db, kv } from './db.js';
import type { Fleet } from './fleet.js';
import { fetchCatalog, itemLabel, type StoreOption } from './store.js';

db.exec(`
CREATE TABLE IF NOT EXISTS store_items (
  product_id INTEGER NOT NULL, combination_id INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '', product_name TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '[]',
  store_qty INTEGER NOT NULL DEFAULT 0, in_store INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0, min_qty INTEGER NOT NULL DEFAULT 0, synced_at INTEGER,
  PRIMARY KEY (product_id, combination_id)
);
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  units_per_plate INTEGER NOT NULL DEFAULT 1, material TEXT NOT NULL DEFAULT '',
  on_hand INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS part_gcodes (
  part_id INTEGER NOT NULL, model TEXT NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL,
  size INTEGER NOT NULL, uploaded_at INTEGER NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (part_id, model)
);
CREATE TABLE IF NOT EXISTS part_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, model TEXT NOT NULL,
  units_per_plate INTEGER NOT NULL DEFAULT 1,            -- per file: a K2 plate or a 3-up layout holds more
  filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS recipes (
  product_id INTEGER NOT NULL, combination_id INTEGER NOT NULL, part_id INTEGER NOT NULL, qty INTEGER NOT NULL,
  PRIMARY KEY (product_id, combination_id, part_id)
);
`);

// Units per plate used to be per part with one file per (part, model): move those files over once.
db.exec(`INSERT INTO part_files (part_id, model, units_per_plate, filename, path, size, uploaded_at, meta_json)
  SELECT g.part_id, g.model, COALESCE(p.units_per_plate, 1), g.filename, g.path, g.size, g.uploaded_at, g.meta_json
  FROM part_gcodes g LEFT JOIN parts p ON p.id = g.part_id`);
db.exec(`DELETE FROM part_gcodes`);

/** Creality's model code (from the :9999 feed) -> the name slicers write as `printer_model`. */
export const MODEL_NAMES: Record<string, string> = { K1C: 'K1C', K1: 'K1', F008: 'K2 Plus', K1MAX: 'K1 Max' };
const modelName = (m: string) => MODEL_NAMES[m] || m;

const LIBRARY = join(config.dataDir, 'gcode-library');
const MAX_GCODE_BYTES = 300 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Store sync

export interface SyncStatus {
  lastSyncAt: number | null; lastAttemptAt: number | null; lastError: string | null;
  items: number; reason: string | null; running: boolean;
}
const STATUS_KEY = 'store:sync';
const DASHBOARD_MIN_GAP_MS = 5 * 60_000;
let running: Promise<SyncStatus> | null = null;

export function syncStatus(): SyncStatus {
  const s = JSON.parse(kv.get(STATUS_KEY) || '{}');
  return { lastSyncAt: s.lastSyncAt ?? null, lastAttemptAt: s.lastAttemptAt ?? null, lastError: s.lastError ?? null,
    items: s.items ?? 0, reason: s.reason ?? null, running: !!running };
}

/**
 * Read the store's catalogue and stock. Triggers (owner's rule): a printer becomes free,
 * "Sync now", the dashboard is opened (at most every 5 min), hourly while a printer is free.
 * One sync at a time; concurrent callers share it.
 */
export function syncStore(reason: string): Promise<SyncStatus> {
  if (running) return running;
  const st = syncStatus();
  if (reason === 'dashboard' && st.lastSyncAt && Date.now() - st.lastSyncAt < DASHBOARD_MIN_GAP_MS) return Promise.resolve(st);
  if (!config.store.apiKey) return Promise.resolve({ ...st, lastError: 'STORE_API_KEY is not set' });
  running = (async () => {
    const at = Date.now();
    try {
      const items = await fetchCatalog();
      const upsert = db.prepare(`
        INSERT INTO store_items (product_id, combination_id, reference, product_name, options_json, store_qty, in_store, synced_at)
        VALUES (@productId, @combinationId, @reference, @productName, @options, @quantity, 1, @at)
        ON CONFLICT (product_id, combination_id) DO UPDATE SET reference = excluded.reference,
          product_name = excluded.product_name, options_json = excluded.options_json,
          store_qty = excluded.store_qty, in_store = 1, synced_at = excluded.synced_at`);
      db.transaction(() => {
        db.prepare('UPDATE store_items SET in_store = 0').run();   // anything not seen now left the store
        for (const i of items) upsert.run({ ...i, options: JSON.stringify(i.options), at });
      })();
      kv.set(STATUS_KEY, JSON.stringify({ lastSyncAt: at, lastAttemptAt: at, lastError: null, items: items.length, reason }));
      console.log(`[store] synced ${items.length} items (${reason}) in ${Date.now() - at} ms`);
    } catch (e: any) {
      const prev = JSON.parse(kv.get(STATUS_KEY) || '{}');
      kv.set(STATUS_KEY, JSON.stringify({ ...prev, lastAttemptAt: at, lastError: String(e?.message || e), reason }));
      console.warn(`[store] sync failed (${reason}): ${e?.message || e}`);
    } finally { running = null; }
    return syncStatus();
  })();
  return running;
}

/** A printer that's online, enabled and not doing anything. */
function anyPrinterFree(fleet: Fleet): boolean {
  return fleet.getStates().some(s => s.online && !s.preparing && ['standby', 'complete', 'cancelled'].includes(s.state));
}

// ---------------------------------------------------------------------------
// Rows -> API objects

const colourOf = (opts: StoreOption[]) => opts.find(o => /colou?r/i.test(o.group))?.value ?? null;

function itemsWithRecipes() {
  const recipes = db.prepare('SELECT * FROM recipes').all() as any[];
  return (db.prepare('SELECT * FROM store_items ORDER BY product_id, combination_id').all() as any[]).map(r => {
    const options: StoreOption[] = JSON.parse(r.options_json || '[]');
    return {
      productId: r.product_id, combinationId: r.combination_id, reference: r.reference,
      productName: r.product_name, options, colour: colourOf(options),
      label: itemLabel({ productId: r.product_id, combinationId: r.combination_id, reference: r.reference,
        productName: r.product_name, options, quantity: r.store_qty }),
      storeQty: r.store_qty, inStore: !!r.in_store, enabled: !!r.enabled, minQty: r.min_qty, syncedAt: r.synced_at,
      recipe: recipes.filter(x => x.product_id === r.product_id && x.combination_id === r.combination_id)
        .map(x => ({ partId: x.part_id, qty: x.qty })),
    };
  });
}

function partsWithGcodes() {
  const g = db.prepare('SELECT * FROM part_files ORDER BY model, units_per_plate DESC, id').all() as any[];
  return (db.prepare('SELECT * FROM parts ORDER BY name').all() as any[]).map(p => ({
    id: p.id, name: p.name, material: p.material,
    notes: p.notes, createdAt: p.created_at,
    files: g.filter(x => x.part_id === p.id).map(x => ({
      id: x.id, unitsPerPlate: x.units_per_plate, model: x.model, modelName: modelName(x.model), filename: x.filename, size: x.size,
      uploadedAt: x.uploaded_at, meta: JSON.parse(x.meta_json || '{}'),
    })),
  }));
}

// ---------------------------------------------------------------------------
// G-code metadata (Creality Print / Orca write settings as "; key = value", mostly at the end)

export interface GcodeMeta {
  printerModel?: string; filamentType?: string; filamentColour?: string; printTime?: string;
  nozzle?: string; generator?: string; warnings: string[];
}

function readEnds(path: string, bytes = 256 * 1024): string {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(bytes, size)); readSync(fd, head, 0, head.length, 0);
    const tailLen = Math.min(bytes, Math.max(0, size - head.length));
    const tail = Buffer.alloc(tailLen); if (tailLen) readSync(fd, tail, 0, tailLen, size - tailLen);
    return head.toString('latin1') + '\n' + tail.toString('latin1');
  } finally { closeSync(fd); }
}

export function gcodeMeta(path: string, model: string): GcodeMeta {
  const text = readEnds(path);
  const val = (re: RegExp) => text.match(re)?.[1]?.trim().replace(/^"|"$/g, '');
  const meta: GcodeMeta = {
    printerModel: val(/^;\s*printer_model\s*=\s*(.+)$/m),
    filamentType: val(/^;\s*filament_type\s*=\s*(.+)$/m),
    filamentColour: val(/^;\s*filament_colour\s*=\s*(.+)$/m),
    printTime: val(/^;\s*estimated printing time[^=]*=\s*(.+)$/m),
    nozzle: val(/^;\s*nozzle_diameter\s*=\s*(.+)$/m),
    generator: val(/^;\s*generated by\s+(.+?)(?:\s+on\s+\d|$)/m),
    warnings: [],
  };
  if (!/^G[0-3]\s/m.test(text)) meta.warnings.push('No movement commands found: is this a G-code file?');
  const want = `Creality ${modelName(model)}`;
  if (!meta.printerModel) meta.warnings.push(`The file doesn't say which printer it was sliced for (expected "${want}").`);
  else if (meta.printerModel.toLowerCase() !== want.toLowerCase())
    meta.warnings.push(`Sliced for "${meta.printerModel}", but uploaded for ${modelName(model)} ("${want}"). Printing a file sliced for another model can fail (Usopp, 2026-11-09).`);
  return meta;
}

// ---------------------------------------------------------------------------
// Routes

const int = (v: any, min = 0, max = 1_000_000) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const safeModel = (m: string) => /^[A-Za-z0-9_-]{1,20}$/.test(m) ? m : null;

export function registerInventory(app: FastifyInstance, fleet: Fleet) {
  // Raw G-code uploads (no multipart dependency): PUT with the file as the body.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_GCODE_BYTES },
    (_req: any, body: any, done: any) => done(null, body));

  // Hourly sync, only while some printer is free (owner's rule, 2026-11-17).
  setInterval(() => { if (anyPrinterFree(fleet)) syncStore('hourly').catch(() => {}); }, 60 * 60_000);

  app.get('/api/store/items', async () => ({ status: syncStatus(), items: itemsWithRecipes() }));

  app.post('/api/store/sync', async (req) => {
    const reason = String((req.body as any)?.reason || 'manual');
    return { status: await syncStore(reason === 'dashboard' ? 'dashboard' : 'manual'), items: itemsWithRecipes() };
  });

  app.patch('/api/store/items/:pid/:cid', async (req, reply) => {
    const { pid, cid } = req.params as any; const b = (req.body || {}) as any;
    const row = db.prepare('SELECT 1 FROM store_items WHERE product_id = ? AND combination_id = ?').get(Number(pid), Number(cid));
    if (!row) return reply.code(404).send({ error: 'Unknown store item.' });
    if (b.enabled !== undefined) db.prepare('UPDATE store_items SET enabled = ? WHERE product_id = ? AND combination_id = ?').run(b.enabled ? 1 : 0, Number(pid), Number(cid));
    if (b.minQty !== undefined) {
      const q = int(b.minQty, 0, 10000); if (q === null) return reply.code(400).send({ error: 'minQty must be a number.' });
      db.prepare('UPDATE store_items SET min_qty = ? WHERE product_id = ? AND combination_id = ?').run(q, Number(pid), Number(cid));
    }
    return itemsWithRecipes().find(i => i.productId === Number(pid) && i.combinationId === Number(cid));
  });

  app.put('/api/store/items/:pid/:cid/recipe', async (req, reply) => {
    const { pid, cid } = req.params as any;
    const parts = Array.isArray((req.body as any)?.parts) ? (req.body as any).parts : null;
    if (!parts) return reply.code(400).send({ error: 'Send { parts: [{ partId, qty }] }.' });
    const known = new Set((db.prepare('SELECT id FROM parts').all() as any[]).map(p => p.id));
    for (const p of parts) {
      if (!known.has(Number(p.partId))) return reply.code(400).send({ error: `Unknown part ${p.partId}.` });
      if (!int(p.qty, 1, 1000)) return reply.code(400).send({ error: 'qty must be 1 or more.' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM recipes WHERE product_id = ? AND combination_id = ?').run(Number(pid), Number(cid));
      const ins = db.prepare('INSERT INTO recipes (product_id, combination_id, part_id, qty) VALUES (?, ?, ?, ?)');
      for (const p of parts) ins.run(Number(pid), Number(cid), Number(p.partId), int(p.qty, 1, 1000));
    })();
    return itemsWithRecipes().find(i => i.productId === Number(pid) && i.combinationId === Number(cid));
  });

  // Printer models in the fleet (for the per-model G-code slots).
  app.get('/api/store/models', async () => {
    const by = new Map<string, string[]>();
    for (const s of fleet.getStates()) {
      const m = fleet.model(s.printerId); if (!m) continue;
      if (!by.has(m)) by.set(m, []);
      by.get(m)!.push(fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`);
    }
    return [...by].map(([model, printers]) => ({ model, name: modelName(model), printers }));
  });

  app.get('/api/parts', async () => partsWithGcodes());

  app.post('/api/parts', async (req, reply) => {
    const b = (req.body || {}) as any; const name = String(b.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'A part needs a name.' });
    if (db.prepare('SELECT 1 FROM parts WHERE name = ?').get(name)) return reply.code(409).send({ error: 'A part with that name exists.' });
    const info = db.prepare('INSERT INTO parts (name, material, notes, created_at) VALUES (?, ?, ?, ?)')
      .run(name, String(b.material || '').trim(), String(b.notes || ''), Date.now());
    return partsWithGcodes().find(p => p.id === Number(info.lastInsertRowid));
  });

  app.patch('/api/parts/:id', async (req, reply) => {
    const id = Number((req.params as any).id); const b = (req.body || {}) as any;
    if (!db.prepare('SELECT 1 FROM parts WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Unknown part.' });
    if (b.name !== undefined) {
      const name = String(b.name).trim(); if (!name) return reply.code(400).send({ error: 'A part needs a name.' });
      if (db.prepare('SELECT 1 FROM parts WHERE name = ? AND id != ?').get(name, id)) return reply.code(409).send({ error: 'A part with that name exists.' });
      db.prepare('UPDATE parts SET name = ? WHERE id = ?').run(name, id);
    }
    if (b.material !== undefined) db.prepare('UPDATE parts SET material = ? WHERE id = ?').run(String(b.material).trim(), id);
    if (b.notes !== undefined) db.prepare('UPDATE parts SET notes = ? WHERE id = ?').run(String(b.notes), id);
    if (b.onHand !== undefined) db.prepare('UPDATE parts SET on_hand = ? WHERE id = ?').run(int(b.onHand, 0, 100000) ?? 0, id);
    return partsWithGcodes().find(p => p.id === id);
  });

  app.delete('/api/parts/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const used = db.prepare('SELECT COUNT(*) n FROM recipes WHERE part_id = ?').get(id) as any;
    if (used.n) return reply.code(409).send({ error: `This part is in ${used.n} recipe(s): remove it from them first.` });
    for (const g of db.prepare('SELECT path FROM part_files WHERE part_id = ?').all(id) as any[]) {
      try { unlinkSync(join(config.dataDir, g.path)); } catch { /* already gone */ }
    }
    try { rmSync(join(LIBRARY, `part-${id}`), { recursive: true, force: true }); } catch { /* ignore */ }
    db.prepare('DELETE FROM part_files WHERE part_id = ?').run(id);
    db.prepare('DELETE FROM part_stock WHERE part_id = ?').run(id);
    db.prepare('DELETE FROM parts WHERE id = ?').run(id);
    return { ok: true };
  });

  // Files: several per part and model, each with its own units per plate.
  // Upload: POST /api/parts/:id/files?model=K1C&units=3, body = the file, header X-Filename.
  // Replace: PUT /api/parts/:id/files/:fileId (same units). Units: PATCH. Remove: DELETE.
  const storeFile = (partId: number, model: string, body: Buffer, rel: string) => {
    mkdirSync(join(LIBRARY, `part-${partId}`), { recursive: true });
    const tmp = join(config.dataDir, rel + '.uploading');
    writeFileSync(tmp, body);
    const meta = gcodeMeta(tmp, model);
    writeFileSync(join(config.dataDir, rel), readFileSync(tmp)); unlinkSync(tmp);
    return meta;
  };
  const fileName = (req: any) => decodeURIComponent(String(req.headers['x-filename'] || 'upload.gcode')).replace(/[\\/]/g, '_').slice(0, 200);
  const bodyOf = (req: any, reply: any) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) { reply.code(400).send({ error: 'Send the G-code file as application/octet-stream.' }); return null; }
    return body;
  };

  app.post('/api/parts/:id/files', async (req, reply) => {
    const id = Number((req.params as any).id); const q = req.query as any;
    const model = safeModel(String(q.model || '')); const units = int(q.units ?? 1, 1, 1000);
    if (!model) return reply.code(400).send({ error: 'Bad printer model.' });
    if (!units) return reply.code(400).send({ error: 'Units per plate must be 1 or more.' });
    if (!db.prepare('SELECT 1 FROM parts WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Unknown part.' });
    const body = bodyOf(req, reply); if (!body) return;
    const info = db.prepare(`INSERT INTO part_files (part_id, model, units_per_plate, filename, path, size, uploaded_at)
      VALUES (?, ?, ?, ?, '', ?, ?)`).run(id, model, units, fileName(req), body.length, Date.now());
    const fid = Number(info.lastInsertRowid);
    const rel = join('gcode-library', `part-${id}`, `${model}-${fid}.gcode`);
    try {
      const meta = storeFile(id, model, body, rel);
      db.prepare('UPDATE part_files SET path = ?, meta_json = ? WHERE id = ?').run(rel, JSON.stringify(meta), fid);
    } catch (e) { db.prepare('DELETE FROM part_files WHERE id = ?').run(fid); throw e; }
    return partsWithGcodes().find(p => p.id === id);
  });

  const fileRow = (req: any) => db.prepare('SELECT * FROM part_files WHERE id = ? AND part_id = ?')
    .get(Number(req.params.fileId), Number(req.params.id)) as any;

  app.put('/api/parts/:id/files/:fileId', async (req, reply) => {
    const f = fileRow(req); if (!f) return reply.code(404).send({ error: 'Unknown file.' });
    const body = bodyOf(req, reply); if (!body) return;
    const meta = storeFile(f.part_id, f.model, body, f.path);
    db.prepare('UPDATE part_files SET filename = ?, size = ?, uploaded_at = ?, meta_json = ? WHERE id = ?')
      .run(fileName(req), body.length, Date.now(), JSON.stringify(meta), f.id);
    return partsWithGcodes().find(p => p.id === f.part_id);
  });

  app.patch('/api/parts/:id/files/:fileId', async (req, reply) => {
    const f = fileRow(req); if (!f) return reply.code(404).send({ error: 'Unknown file.' });
    const units = int((req.body as any)?.unitsPerPlate, 1, 1000);
    if (!units) return reply.code(400).send({ error: 'Units per plate must be 1 or more.' });
    db.prepare('UPDATE part_files SET units_per_plate = ? WHERE id = ?').run(units, f.id);
    return partsWithGcodes().find(p => p.id === f.part_id);
  });

  app.delete('/api/parts/:id/files/:fileId', async (req, reply) => {
    const f = fileRow(req); if (!f) return reply.code(404).send({ error: 'Unknown file.' });
    try { if (existsSync(join(config.dataDir, f.path))) unlinkSync(join(config.dataDir, f.path)); } catch { /* ignore */ }
    db.prepare('DELETE FROM part_files WHERE id = ?').run(f.id);
    return partsWithGcodes().find(p => p.id === f.part_id);
  });
}
