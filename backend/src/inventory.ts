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
import { inventoryState, inventoryHistory, itemLabel, type StoreOption } from './store.js';

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

// Items whose store variant has no colour option get a colour chosen on the dashboard.
if (!(db.prepare('PRAGMA table_info(store_items)').all() as any[]).some(c => c.name === 'priority'))
  db.exec(`ALTER TABLE store_items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);   // 1 high, 0 normal, -1 low
if (!(db.prepare('PRAGMA table_info(recipes)').all() as any[]).some(c => c.name === 'print_colour')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN print_colour TEXT`);         // the line's print colour (null = any), from the store
  db.exec(`ALTER TABLE recipes ADD COLUMN colour_rule TEXT NOT NULL DEFAULT ''`);  // '' item colour, '*' any, else fixed
}
if (!(db.prepare('PRAGMA table_info(store_items)').all() as any[]).some(c => c.name === 'print_as'))
  db.exec(`ALTER TABLE store_items ADD COLUMN print_as TEXT`);   // the module's print colour (null = any)
if (!(db.prepare('PRAGMA table_info(store_items)').all() as any[]).some(c => c.name === 'default_colour'))
  db.exec(`ALTER TABLE store_items ADD COLUMN default_colour TEXT NOT NULL DEFAULT ''`);

// Per product: does the store's colour option decide the filament colour? (Not for products
// where any colour can be printed, e.g. the antlers, 2026-11-17.)
db.exec(`CREATE TABLE IF NOT EXISTS store_products (product_id INTEGER PRIMARY KEY, ignore_store_colour INTEGER NOT NULL DEFAULT 0)`);
const ignoresStoreColour = (productId: number) =>
  !!(db.prepare('SELECT ignore_store_colour v FROM store_products WHERE product_id = ?').get(productId) as any)?.v;

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
      // The store's Printed stock module owns the inventory; mirror it here for the planner and UI.
      const st = await inventoryState();
      mirror(st);
      kv.set(INV_KEY, JSON.stringify({ live: st.live, at, colours: st.colours }));
      inventoryHistory(50).then(h => kv.set(HISTORY_KEY, JSON.stringify(h))).catch(() => {});
      kv.set(STATUS_KEY, JSON.stringify({ lastSyncAt: at, lastAttemptAt: at, lastError: null, items: st.items.length, reason }));
      console.log(`[store] synced ${st.items.length} managed items, ${st.parts.length} parts (${reason}${st.live ? '' : ', store in log-only mode'}) in ${Date.now() - at} ms`);
    } catch (e: any) {
      const prev = JSON.parse(kv.get(STATUS_KEY) || '{}');
      kv.set(STATUS_KEY, JSON.stringify({ ...prev, lastAttemptAt: at, lastError: String(e?.message || e), reason }));
      console.warn(`[store] sync failed (${reason}): ${e?.message || e}`);
    } finally { running = null; }
    return syncStatus();
  })();
  return running;
}

const INV_KEY = 'store:inventory';
export const HISTORY_KEY = 'store:history';
/** Whether the store's Printed stock module is live (writes store quantities). Auto-load waits until it is. */
export const inventoryLive = (): boolean => !!JSON.parse(kv.get(INV_KEY) || '{}').live;

/**
 * Copy the module's state into the local tables: managed items (store_qty = sets buildable,
 * print_as = print colour), recipes, parts on hand, part names (ids are the module's, so the
 * G-code files stay linked to their parts).
 */
function mirror(st: Awaited<ReturnType<typeof inventoryState>>) {
  const now = Date.now();
  db.transaction(() => {
    const upPart = db.prepare(`INSERT INTO parts (id, name, material, notes, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, material = excluded.material, notes = excluded.notes`);
    for (const p of st.parts) {
      try { upPart.run(p.id, p.name, p.material, p.notes || '', now); }
      catch { db.prepare('UPDATE parts SET name = name || \' (old)\' WHERE name = ? AND id <> ?').run(p.name, p.id); upPart.run(p.id, p.name, p.material, p.notes || '', now); }
    }
    db.prepare('UPDATE store_items SET enabled = 0, in_store = 0').run();
    const upItem = db.prepare(`INSERT INTO store_items (product_id, combination_id, reference, product_name, options_json, store_qty, in_store, synced_at,
        enabled, min_qty, priority, default_colour, print_as)
      VALUES (@productId, @combinationId, @reference, @productName, @options, @qty, 1, @at, 1, @minQty, @priority, @printColour, @colour)
      ON CONFLICT (product_id, combination_id) DO UPDATE SET reference = excluded.reference, product_name = excluded.product_name,
        options_json = excluded.options_json, store_qty = excluded.store_qty, in_store = 1, synced_at = excluded.synced_at, enabled = 1,
        min_qty = excluded.min_qty, priority = excluded.priority, default_colour = excluded.default_colour, print_as = excluded.print_as`);
    db.prepare('DELETE FROM recipes').run();
    const addRecipe = db.prepare('INSERT OR REPLACE INTO recipes (product_id, combination_id, part_id, qty, print_colour, colour_rule) VALUES (?, ?, ?, ?, ?, ?)');
    db.prepare('DELETE FROM store_products').run();
    const ignore = db.prepare('INSERT OR REPLACE INTO store_products (product_id, ignore_store_colour) VALUES (?, 1)');
    for (const i of st.items) {
      upItem.run({ productId: i.productId, combinationId: i.combinationId, reference: i.reference, productName: i.productName,
        options: JSON.stringify(i.options.map(o => ({ group: o.group, value: o.value }))),
        // Planning works from what the parts allow (the store shows the same once the module is live).
        qty: i.buildable ?? i.storeQty, at: now, minQty: i.minQty, priority: i.priority, printColour: i.printColour, colour: i.colour });
      // Each line's own colour (e.g. White nose parts on a Caramel Brown antler set); older modules: the item's.
      for (const r of i.recipe) addRecipe.run(i.productId, i.combinationId, r.partId, r.qty,
        r.printColour !== undefined ? r.printColour : i.colour, r.colour ?? '');
      if (i.ignoreStoreColour) ignore.run(i.productId);
    }
    db.prepare('DELETE FROM part_stock').run();
    const addStock = db.prepare('INSERT INTO part_stock (part_id, colour, qty) VALUES (?, ?, ?)');
    for (const s of st.stock) addStock.run(s.partId, s.colour, s.qty);
  })();
}

/** A printer that's online, enabled and not doing anything. */
function anyPrinterFree(fleet: Fleet): boolean {
  return fleet.getStates().some(s => s.online && !s.preparing && ['standby', 'complete', 'cancelled'].includes(s.state));
}

// ---------------------------------------------------------------------------
// Rows -> API objects

const colourOf = (opts: StoreOption[]) => opts.find(o => /colou?r/i.test(o.group))?.value ?? null;
/** The colour an item is printed in: its store colour option (unless the product ignores it), else the one chosen on the dashboard. */
export const itemColour = (opts: StoreOption[], defaultColour: string, productId?: number) =>
  (productId !== undefined && ignoresStoreColour(productId) ? null : colourOf(opts)) ?? (defaultColour || null);

function itemsWithRecipes() {
  const recipes = db.prepare('SELECT * FROM recipes').all() as any[];
  return (db.prepare('SELECT * FROM store_items ORDER BY product_id, combination_id').all() as any[]).map(r => {
    const options: StoreOption[] = JSON.parse(r.options_json || '[]');
    return {
      productId: r.product_id, combinationId: r.combination_id, reference: r.reference,
      productName: r.product_name, options, colour: r.print_as ?? null,
      colourFromStore: !!colourOf(options) && !ignoresStoreColour(r.product_id), hasStoreColour: !!colourOf(options),
      ignoreStoreColour: ignoresStoreColour(r.product_id), defaultColour: r.default_colour,
      label: itemLabel({ productId: r.product_id, combinationId: r.combination_id, reference: r.reference,
        productName: r.product_name, options, quantity: r.store_qty }),
      storeQty: r.store_qty, inStore: !!r.in_store, enabled: !!r.enabled, minQty: r.min_qty, priority: r.priority ?? 0, syncedAt: r.synced_at,
      recipe: recipes.filter(x => x.product_id === r.product_id && x.combination_id === r.combination_id)
        .map(x => ({ partId: x.part_id, qty: x.qty, colour: x.colour_rule === '*' ? null : (x.print_colour ?? r.print_as ?? null) })),
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

  // Items, recipes, parts and on-hand counts are edited in the store (Catalog > Printed stock) since 2026-11-18.
  const inStore = async (_req: any, reply: any) => reply.code(410).send({ error: 'Edit this in the store admin: Catalog > Printed stock.' });
  app.patch('/api/store/items/:pid/:cid', inStore);
  app.patch('/api/store/products/:pid', inStore);
  app.put('/api/store/items/:pid/:cid/recipe', inStore);
  app.post('/api/parts', inStore);
  app.patch('/api/parts/:id', inStore);
  app.delete('/api/parts/:id', inStore);
  app.get('/api/store/inventory', async () => ({ live: inventoryLive(), adminUrl: `${config.store.url}/onic_admin/index.php?controller=AdminOnicPrint`,
    history: JSON.parse(kv.get(HISTORY_KEY) || '{"moves":[],"quantities":[]}') }));

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
