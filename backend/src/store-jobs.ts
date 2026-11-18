// Store-driven printing, phase 2 (dry run): which printers can take store jobs, what
// filament they have, and the plan: shortfalls -> plates of parts -> the printer each would
// go to (or why it can't yet). Nothing is sent to printers in this phase.
import type { FastifyInstance } from 'fastify';
import { db, kv } from './db.js';
import type { Fleet } from './fleet.js';
import type { Spool } from './creality.js';
import type { LiveState } from './types.js';
import { MODEL_NAMES, syncStore } from './inventory.js';
import type { StoreOption } from './store.js';

db.exec(`
CREATE TABLE IF NOT EXISTS printer_job_settings (
  printer_id INTEGER PRIMARY KEY,
  available INTEGER NOT NULL DEFAULT 0,        -- owner's switch: may take store jobs
  bed_clear INTEGER NOT NULL DEFAULT 0,        -- owner confirmed the bed is empty since the last print
  bed_clear_at INTEGER,
  manual_material TEXT NOT NULL DEFAULT '',    -- for printers that can't report their spool (1.3.x K1C firmware)
  manual_colour TEXT NOT NULL DEFAULT ''       -- a store colour name
);
CREATE TABLE IF NOT EXISTS store_jobs (       -- phase 3: one plate sent to a printer
  id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, file_id INTEGER, colour TEXT NOT NULL DEFAULT '',
  units INTEGER NOT NULL, printer_id INTEGER NOT NULL, printer_file TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                        -- loading, loaded, printing, printed, completed, failed, cancelled
  for_items TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, loaded_at INTEGER, started_at INTEGER, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS part_stock (        -- parts on hand, per colour ('' = no colour)
  part_id INTEGER NOT NULL, colour TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (part_id, colour)
);
`);
// Phase 1 kept one on-hand number per part: move it to the no-colour row once.
db.exec(`INSERT OR IGNORE INTO part_stock (part_id, colour, qty) SELECT id, '', on_hand FROM parts WHERE on_hand > 0`);
db.exec(`UPDATE parts SET on_hand = 0`);

// ---------------------------------------------------------------------------
// Colours: store colour names (from options whose group mentions "colour") -> hex.

const COLOURS_KEY = 'store:colours';
const DEFAULT_COLOURS: Record<string, string> = { White: '#ffffff', Black: '#000000' };
const isColourGroup = (g: string) => /colou?r/i.test(g);

export function colourMap(): Record<string, string> {
  return { ...DEFAULT_COLOURS, ...JSON.parse(kv.get(COLOURS_KEY) || '{}') };
}
function storeColourNames(): string[] {
  const names = new Set<string>();
  for (const r of db.prepare('SELECT options_json FROM store_items WHERE in_store = 1').all() as any[])
    for (const o of JSON.parse(r.options_json || '[]') as StoreOption[]) if (isColourGroup(o.group)) names.add(o.value);
  return [...names].sort();
}
const rgb = (h: string) => /^#[0-9a-f]{6}$/i.test(h) ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : null;
/** Same colour, allowing for how loosely spool colours are entered on the printer. */
function sameColour(a: string, b: string): boolean {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return false;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 70;
}
const normMaterial = (m: string) => m.toUpperCase().replace(/[^A-Z]/g, '').replace(/PLUS$/, '');
function sameMaterial(want: string, have: string): boolean {
  if (!want.trim()) return true;                       // part doesn't care
  const a = normMaterial(want), b = normMaterial(have);
  return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
}

// ---------------------------------------------------------------------------
// Printers

interface JobSettings { available: boolean; bedClear: boolean; bedClearAt: number | null; manualMaterial: string; manualColour: string }
function settings(printerId: number): JobSettings {
  const r = db.prepare('SELECT * FROM printer_job_settings WHERE printer_id = ?').get(printerId) as any;
  return { available: !!r?.available, bedClear: !!r?.bed_clear, bedClearAt: r?.bed_clear_at ?? null,
    manualMaterial: r?.manual_material ?? '', manualColour: r?.manual_colour ?? '' };
}
function saveSettings(printerId: number, patch: Partial<Record<'available' | 'bed_clear' | 'bed_clear_at' | 'manual_material' | 'manual_colour', any>>) {
  db.prepare('INSERT OR IGNORE INTO printer_job_settings (printer_id) VALUES (?)').run(printerId);
  for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE printer_job_settings SET ${k} = ? WHERE printer_id = ?`).run(v, printerId);
}

const IDLE = ['standby', 'complete', 'cancelled'];
export const ACTIVE_JOB = ['loading', 'loaded', 'printing', 'printed'];
/** The store job a printer is holding (loaded, printing or printed and not yet confirmed). */
export function activeJob(printerId: number): any {
  return db.prepare(`SELECT * FROM store_jobs WHERE printer_id = ? AND status IN ('loading','loaded','printing','printed') ORDER BY id DESC LIMIT 1`).get(printerId);
}
const busy = (s: LiveState) => !!s.preparing || s.state === 'printing' || s.state === 'paused';

export interface PrinterReadiness {
  id: number; name: string; model: string | null; modelName: string | null; state: string; online: boolean;
  available: boolean; bedClear: boolean; ready: boolean; why: string | null;
  filamentSource: 'printer' | 'manual' | 'none'; spools: (Spool & { colourName: string | null })[];
  manualMaterial: string; manualColour: string;
}

function readiness(fleet: Fleet, s: LiveState, colours: Record<string, string>): PrinterReadiness {
  const st = settings(s.printerId);
  const model = fleet.model(s.printerId);
  const reported = fleet.spools(s.printerId);
  const nameOf = (hex: string) => Object.entries(colours).find(([, h]) => sameColour(h, hex))?.[0] ?? null;
  let spools: PrinterReadiness['spools'] = [];
  let source: PrinterReadiness['filamentSource'] = 'none';
  if (Array.isArray(reported)) { spools = reported.map(sp => ({ ...sp, colourName: nameOf(sp.colour) })); source = 'printer'; }
  else if (st.manualMaterial || st.manualColour) {
    spools = [{ slot: 'Set on the dashboard', material: st.manualMaterial, colour: colours[st.manualColour] || '', name: '', colourName: st.manualColour || null }];
    source = 'manual';
  }
  const why = !s.online ? 'offline'
    : busy(s) ? (s.preparing ? 'preparing a print' : s.state)
    : !IDLE.includes(s.state) ? `printer is in ${s.state}`
    : !st.available ? 'not available for store jobs'
    : activeJob(s.printerId) ? `store job ${activeJob(s.printerId).status}`
    : !st.bedClear ? 'bed not confirmed clear'
    : !spools.length ? (reported === null ? 'set its loaded filament' : reported === undefined ? 'reading its spools…' : 'no spool loaded')
    : s.filamentDetected === false ? 'filament sensor reads empty: load filament'
    : null;
  return { id: s.printerId, name: fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`,
    model, modelName: model ? MODEL_NAMES[model] || model : null, state: s.preparing ? 'preparing' : s.state, online: s.online,
    available: st.available, bedClear: st.bedClear, ready: !why, why, filamentSource: source, spools,
    manualMaterial: st.manualMaterial, manualColour: st.manualColour };
}

// ---------------------------------------------------------------------------
// Plan (dry run)

export interface PlannedJob {
  partId: number; part: string; colour: string | null; material: string; unitsPerPlate: number;
  file: { id: number; filename: string; model: string } | null;   // the G-code this plate would use
  forItems: string[]; printer: { id: number; name: string } | null; reason: string | null;
  stage: 'out' | 'min';   // 'out': first unit of an out-of-stock item; 'min': filling up to the minimum
  priority: number;       // 1 high, 0 normal, -1 low
}

interface PartFile { id: number; model: string; units: number; filename: string }
/** The file for a plate: the biggest layout that doesn't overshoot what's still needed, else the smallest. */
function bestFile(files: PartFile[], remaining: number): PartFile | null {
  if (!files.length) return null;
  const fit = files.filter(f => f.units <= remaining).sort((a, b) => b.units - a.units)[0];
  return fit ?? [...files].sort((a, b) => a.units - b.units)[0];
}

/**
 * Take up to `qty` of a part from a stock map keyed `part|colour`. An item with a colour only
 * takes that colour; an "any colour" item takes uncoloured parts first, then any colour
 * (most plentiful first). Returns how many were taken and from which colours.
 */
export function takeParts(stock: Map<string, number>, partId: number, colour: string | null, qty: number) {
  const keys = colour ? [`${partId}|${colour}`]
    : [`${partId}|`, ...[...stock.keys()].filter(k => k.startsWith(`${partId}|`) && k !== `${partId}|`)
        .sort((a, b) => (stock.get(b) ?? 0) - (stock.get(a) ?? 0))];
  let taken = 0; const from: [string, number][] = [];
  for (const k of keys) {
    if (taken >= qty) break;
    const n = Math.min(stock.get(k) ?? 0, qty - taken);
    if (n > 0) { stock.set(k, (stock.get(k) ?? 0) - n); taken += n; from.push([k.slice(k.indexOf('|') + 1), n]); }
  }
  return { taken, from };
}

export function plan(fleet: Fleet) {
  const colours = colourMap();
  const printers = fleet.getStates().map(s => readiness(fleet, s, colours));
  const parts = new Map((db.prepare('SELECT * FROM parts').all() as any[]).map(p => [p.id, p]));
  const filesOf = new Map<number, PartFile[]>();
  for (const f of db.prepare('SELECT id, part_id, model, units_per_plate, filename FROM part_files').all() as any[]) {
    if (!filesOf.has(f.part_id)) filesOf.set(f.part_id, []);
    filesOf.get(f.part_id)!.push({ id: f.id, model: f.model, units: Math.max(1, f.units_per_plate), filename: f.filename });
  }
  const gcodeModels = new Map<number, Set<string>>([...filesOf].map(([id, fs]) => [id, new Set(fs.map(f => f.model))]));
  const onHand = new Map<string, number>();
  for (const r of db.prepare('SELECT * FROM part_stock').all() as any[]) onHand.set(`${r.part_id}|${r.colour}`, r.qty);
  const recipes = db.prepare('SELECT * FROM recipes').all() as any[];
  // Plates already on their way count like parts on hand.
  for (const j of db.prepare(`SELECT part_id, colour, SUM(units) u FROM store_jobs WHERE status IN ('loading','loaded','printing','printed') GROUP BY part_id, colour`).all() as any[])
    onHand.set(`${j.part_id}|${j.colour}`, (onHand.get(`${j.part_id}|${j.colour}`) ?? 0) + j.u);
  const failures = new Map<string, number>();
  for (const j of db.prepare(`SELECT part_id, colour, COUNT(*) n FROM store_jobs WHERE status = 'failed' AND ended_at > ? GROUP BY part_id, colour`).all(Date.now() - 86400e3) as any[])
    failures.set(`${j.part_id}|${j.colour}`, j.n);

  // Managed items below their minimum. Print order (owner, 2026-11-17): the item's priority
  // (High / Normal / Low) first; within it, the first unit of every out-of-stock item before
  // anything that only fills up to the minimum; then furthest below (fraction of the minimum).
  const short = (db.prepare('SELECT * FROM store_items WHERE enabled = 1 AND in_store = 1 AND min_qty > 0').all() as any[])
    .map(r => {
      const options: StoreOption[] = JSON.parse(r.options_json || '[]');
      const label = `${r.reference || r.product_name}`;
      const recipe = recipes.filter(x => x.product_id === r.product_id && x.combination_id === r.combination_id);
      return { r, label, colour: (r.print_as ?? null) as string | null, recipe, priority: Number(r.priority) || 0,
        out: r.store_qty <= 0, short: Math.max(0, r.min_qty - r.store_qty), fraction: (r.min_qty - r.store_qty) / r.min_qty };
    })
    .filter(x => x.short > 0)
    .sort((a, b) => b.priority - a.priority || Number(b.out) - Number(a.out) || b.fraction - a.fraction);

  // Demands: an out-of-stock item's first set (stage 'out'), then the rest up to its minimum ('min').
  type Stage = 'out' | 'min';
  const demands: { x: typeof short[number]; stage: Stage; sets: number }[] = [];
  for (const x of short) {
    const first = x.out ? 1 : 0;
    if (first) demands.push({ x, stage: 'out', sets: first });
    if (x.short - first > 0) demands.push({ x, stage: 'min', sets: x.short - first });
  }
  demands.sort((a, b) => b.x.priority - a.x.priority || (a.stage === b.stage ? 0 : a.stage === 'out' ? -1 : 1)
    || Number(b.x.out) - Number(a.x.out) || b.x.fraction - a.x.fraction);

  // Parts needed per (part, colour, priority, stage), in that order. store_qty is already the sets
  // the parts on hand allow (the store's Printed stock module), and a part shared by several items
  // counts for each of them (as the store shows it). So per part + colour the target is the most
  // any waiting item needs (qty per set x the sets it should reach), not the sum; on hand and
  // plates on their way count against it.
  const availableFor = (partId: number, colour: string | null) => {
    let n = 0;
    for (const [k, q] of onHand) if (colour !== null ? k === `${partId}|${colour}` : k.startsWith(`${partId}|`)) n += Math.max(0, q);
    return n;
  };
  const planned = new Map<string, number>();
  const need = new Map<string, { partId: number; colour: string | null; qty: number; forItems: string[]; stage: Stage; priority: number }>();
  for (const d of demands) {
    const targetSets = d.stage === 'out' ? 1 : d.x.r.min_qty;
    for (const line of d.x.recipe) {
      if (!parts.get(line.part_id)) continue;
      const pc = `${line.part_id}|${d.x.colour ?? ''}`;
      // An "any colour" item is also served by plates planned in a specific colour.
      const alreadyPlanned = d.x.colour !== null ? (planned.get(pc) ?? 0)
        : [...planned].reduce((n, [k, v]) => n + (k.startsWith(`${line.part_id}|`) ? v : 0), 0);
      const extra = line.qty * targetSets - availableFor(line.part_id, d.x.colour) - alreadyPlanned;
      if (extra <= 0) continue;
      planned.set(pc, (planned.get(pc) ?? 0) + extra);
      const key = `${line.part_id}|${d.x.colour ?? ''}|${d.x.priority}|${d.stage}`;
      if (!need.has(key)) need.set(key, { partId: line.part_id, colour: d.x.colour, qty: 0, forItems: [], stage: d.stage, priority: d.x.priority });
      const n = need.get(key)!; n.qty += extra; if (!n.forItems.includes(d.x.label)) n.forItems.push(d.x.label);
    }
  }
  const items = short.map(x => ({
    productId: x.r.product_id, combinationId: x.r.combination_id,
    reference: x.r.reference, label: x.label, storeQty: x.r.store_qty, minQty: x.r.min_qty, short: x.short, colour: x.colour,
    priority: x.priority, outOfStock: x.out, problems: x.recipe.length ? [] : ['no recipe'],
  }));

  // Plates, then a printer for each (one plate per printer), in print order. A plate's layout is
  // chosen against everything still needed of that part + colour (so a 3-up still gets used), and
  // extra units from an early plate count towards the later needs.
  const totalLeft = new Map<string, number>();
  for (const n of need.values()) { const k = `${n.partId}|${n.colour ?? ''}`; totalLeft.set(k, (totalLeft.get(k) ?? 0) + n.qty); }
  const surplus = new Map<string, number>();
  const free = printers.filter(p => p.ready);
  const jobs: PlannedJob[] = [];
  for (const n of need.values()) {
    const part = parts.get(n.partId)!;
    const files = filesOf.get(n.partId) ?? [];
    const pc = `${n.partId}|${n.colour ?? ''}`;
    const extra = Math.min(surplus.get(pc) ?? 0, n.qty);
    surplus.set(pc, (surplus.get(pc) ?? 0) - extra);   // already taken off totalLeft when that plate was planned
    let remaining = n.qty - extra;
    while (remaining > 0) {
      const wantHex = n.colour ? colours[n.colour] : undefined;
      const fits = (p: PrinterReadiness) => {
        if (!p.model || !gcodeModels.get(n.partId)?.has(p.model)) return 'no G-code for its model';
        const ok = p.spools.some(sp => sameMaterial(part.material, sp.material)
          && (!n.colour || (p.filamentSource === 'manual' ? sp.colourName === n.colour : !!wantHex && sameColour(wantHex, sp.colour))));
        return ok ? null : 'filament does not match';
      };
      const failed = failures.get(`${n.partId}|${n.colour ?? ''}`) ?? 0;
      const pick = failed >= 3 ? undefined : free.find(p => !fits(p));
      let reason: string | null = null;
      if (pick) free.splice(free.indexOf(pick), 1);
      else if (failed >= 3) reason = `Failed ${failed} times in the last 24 h: check the printers and the file before it is tried again`;
      else if (!gcodeModels.get(n.partId)?.size) reason = 'No G-code uploaded for this part';
      else if (n.colour && !wantHex) reason = `Set a colour for “${n.colour}” in the colour table`;
      else if (!printers.some(p => p.model && gcodeModels.get(n.partId)!.has(p.model)))
        reason = `No printer of a model with a G-code file (${[...gcodeModels.get(n.partId)!].map(m => MODEL_NAMES[m] || m).join(', ')})`;
      else {
        const compatible = printers.filter(p => p.model && gcodeModels.get(n.partId)!.has(p.model));
        const withFilament = compatible.filter(p => p.spools.length && !fits({ ...p }));
        reason = withFilament.length
          ? `Waiting for ${withFilament.map(p => `${p.name} (${p.why || 'taken by another job'})`).join(', ')}`
          : `No ${compatible.map(p => p.modelName).filter((v, k, a) => a.indexOf(v) === k).join('/')} printer has ${[part.material, n.colour].filter(Boolean).join(' ') || 'the filament'} loaded`;
      }
      // The printer's model decides which files can be used; without a printer, plan with any file.
      const left = Math.max(remaining, totalLeft.get(pc) ?? remaining);
      const file = bestFile(pick ? files.filter(f => f.model === pick.model) : files, left);
      const units = file?.units ?? remaining;   // no file at all: one line for the whole amount
      remaining -= units; totalLeft.set(pc, (totalLeft.get(pc) ?? 0) - units);
      jobs.push({ partId: n.partId, part: part.name, colour: n.colour, material: part.material, unitsPerPlate: units,
        file: file ? { id: file.id, filename: file.filename, model: file.model } : null,
        forItems: n.forItems, printer: pick ? { id: pick.id, name: pick.name } : null, reason, stage: n.stage, priority: n.priority });
    }
    if (remaining < 0) surplus.set(pc, (surplus.get(pc) ?? 0) - remaining);
  }
  return { computedAt: Date.now(), dryRun: true, items, jobs, printers };
}

// Called after a printer becomes free and the store was re-read (phase 3 loads jobs then).
let afterPrinterFree: () => void = () => {};
export const setAfterPrinterFree = (fn: () => void) => { afterPrinterFree = fn; };
const printerFree = () => syncStore('printer-free').then(() => afterPrinterFree()).catch(() => {});

// ---------------------------------------------------------------------------
// Events and routes

export function registerStoreJobs(app: FastifyInstance, fleet: Fleet) {
  // Bed tracking: a print starting means the bed is occupied until the owner says it's clear.
  // A printer becoming ready (idle + available + bed clear) is a store-sync trigger.
  const wasBusy = new Map<number, boolean>();
  const wasReady = new Map<number, boolean>();
  fleet.on('state', (s: LiveState) => {
    const b = busy(s);
    if (b && !wasBusy.get(s.printerId) && settings(s.printerId).bedClear) saveSettings(s.printerId, { bed_clear: 0 });
    wasBusy.set(s.printerId, b);
    const ready = readiness(fleet, s, colourMap()).ready;
    if (ready && wasReady.get(s.printerId) === false) printerFree();
    wasReady.set(s.printerId, ready);
  });

  const state = (id: number) => fleet.getStates().find(s => s.printerId === id);
  const printerOut = (id: number) => { const s = state(id); return s ? readiness(fleet, s, colourMap()) : null; };

  app.get('/api/store/plan', async () => plan(fleet));

  app.patch('/api/store/printers/:id', async (req, reply) => {
    const id = Number((req.params as any).id); const b = (req.body || {}) as any;
    if (!state(id)) return reply.code(404).send({ error: 'Unknown printer.' });
    if (b.available !== undefined) saveSettings(id, { available: b.available ? 1 : 0 });
    if (b.manualMaterial !== undefined) saveSettings(id, { manual_material: String(b.manualMaterial).trim().slice(0, 30) });
    if (b.manualColour !== undefined) saveSettings(id, { manual_colour: String(b.manualColour).trim().slice(0, 60) });
    if (b.available) printerFree();
    return printerOut(id);
  });

  app.post('/api/store/printers/:id/bed-cleared', async (req, reply) => {
    const id = Number((req.params as any).id); const s = state(id);
    if (!s) return reply.code(404).send({ error: 'Unknown printer.' });
    if (busy(s)) return reply.code(409).send({ error: 'The printer is busy: the bed can only be cleared when nothing is printing.' });
    saveSettings(id, { bed_clear: 1, bed_clear_at: Date.now() });
    fleet.refreshSpools(id);
    printerFree();
    return printerOut(id);
  });

  app.post('/api/store/printers/:id/refresh-filament', async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!fleet.refreshSpools(id)) return reply.code(409).send({ error: 'The printer is not connected.' });
    await new Promise(r => setTimeout(r, 2500));
    return printerOut(id);
  });

  app.get('/api/store/colours', async () => ({ map: colourMap(), storeColours: storeColourNames() }));
  app.put('/api/store/colours', async (req, reply) => {
    const map = (req.body as any)?.map;
    if (!map || typeof map !== 'object') return reply.code(400).send({ error: 'Send { map: { "Colour name": "#rrggbb" } }.' });
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      const hex = String(v).trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hex)) return reply.code(400).send({ error: `“${k}”: use a colour like #a0522d.` });
      clean[String(k)] = hex;
    }
    kv.set(COLOURS_KEY, JSON.stringify(clean));
    return { map: colourMap(), storeColours: storeColourNames() };
  });

  // Parts on hand per colour.
  app.get('/api/parts/stock', async () => db.prepare('SELECT part_id AS partId, colour, qty FROM part_stock WHERE qty > 0').all());
  app.put('/api/parts/:id/stock', async (_req, reply) => reply.code(410).send({ error: 'Count parts in the store admin: Catalog > Printed stock.' }));

}
