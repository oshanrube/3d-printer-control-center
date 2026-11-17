// Store inventory (phase 1): the store's items with minimum stock and recipes, and the printed
// parts with their G-code per printer model. Read-only towards the store.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type JobsState, type Part, type Plan, type PrinterModel, type StoreItem, type StoreJob, type SyncStatus } from './api';

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
const kb = (n: number) => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
const fail = (what: string) => (e: any) => alert(`${what}: ${e?.message || e}`);

/**
 * An input that keeps what you type until you leave it (blur or Enter), then saves if it
 * changed. The dashboard re-renders every second with live printer data; an input bound
 * straight to the saved value was reset mid-typing, so edits were silently lost.
 */
function EditField({ value, onSave, type = 'text', ...rest }: { value: string | number; onSave: (v: string) => void; type?: string; [k: string]: any }) {
  const [v, setV] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setV(String(value)); }, [value, editing]);
  const commit = () => { setEditing(false); if (v.trim() !== String(value)) onSave(v.trim()); };
  return <input {...rest} type={type} value={v} onFocus={() => setEditing(true)}
    onInput={(e: any) => { setEditing(true); setV(e.currentTarget.value); }} onBlur={commit}
    onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(String(value)); setEditing(false); } }} />;
}

export type InventoryTab = 'items' | 'parts' | 'colours' | 'queue' | 'jobs';
export const INVENTORY_TABS: InventoryTab[] = ['items', 'parts', 'colours', 'queue', 'jobs'];

/** The store inventory page (#/inventory[/tab]): the tab lives in the address, so reload and Back keep it. */
export function InventoryPage({ tab }: { tab: InventoryTab }) {
  const setTab = (t: InventoryTab) => { location.hash = `#/inventory/${t}`; };
  const [items, setItems] = useState<StoreItem[] | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [models, setModels] = useState<PrinterModel[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [stock, setStock] = useState<{ partId: number; colour: string; qty: number }[]>([]);
  const [storeColours, setStoreColours] = useState<string[]>([]);
  const [counts, setCounts] = useState<{ plates: number; short: number; activeJobs: number } | null>(null);

  const loadItems = () => api.storeItems().then(r => { setItems(r.items); setStatus(r.status); }).catch(fail('Loading store items'));
  const loadParts = () => { api.parts().then(setParts).catch(fail('Loading parts')); api.partStock().then(setStock).catch(() => {}); };
  const loadCounts = () => Promise.all([api.plan(), api.storeJobs()]).then(([p, j]) => setCounts({
    plates: p.jobs.length, short: p.items.length,
    activeJobs: j.jobs.filter(x => ['loading', 'loaded', 'printing', 'printed'].includes(x.status)).length,
  })).catch(() => {});
  useEffect(() => { loadItems(); loadParts(); loadCounts(); api.models().then(setModels).catch(() => {}); api.colours().then(c => setStoreColours(c.storeColours)).catch(() => {}); }, []);
  useEffect(() => { loadCounts(); }, [tab]);

  const syncNow = async () => {
    setSyncing(true);
    try { const r = await api.storeSync('manual'); setItems(r.items); setStatus(r.status); loadCounts(); }
    catch (e: any) { fail('Sync')(e); } finally { setSyncing(false); }
  };
  const replaceItem = (u: StoreItem) => setItems(xs => xs && xs.map(x => x.productId === u.productId && x.combinationId === u.combinationId ? u : x));
  const replacePart = (u: Part) => setParts(ps => ps.map(p => p.id === u.id ? u : p));
  const managed = items?.filter(i => i.enabled).length ?? 0;
  const TABS: { id: InventoryTab; label: string; badge?: string | number; warn?: boolean }[] = [
    { id: 'items', label: 'Store items', badge: items ? `${managed} managed` : undefined },
    { id: 'parts', label: 'Printed parts', badge: parts.length },
    { id: 'queue', label: 'Queue', badge: counts ? `${counts.plates} plate${counts.plates === 1 ? '' : 's'}` : undefined },
    { id: 'jobs', label: 'Jobs', badge: counts?.activeJobs ? `${counts.activeJobs} active` : undefined, warn: !!counts?.activeJobs },
    { id: 'colours', label: 'Colours' },
  ];

  return (
    <section class="inv-page">
      <div class="inv-head">
        <h2>Store inventory</h2>
        <div class="spacer" />
        <span class={`sync-state ${status?.lastError ? 'bad' : ''}`} title={status?.lastError || ''}>
          {status?.lastError ? `⚠️ Sync failed ${ago(status.lastAttemptAt)}` : `Synced ${ago(status?.lastSyncAt ?? null)}`}
        </span>
        <button class="btn btn-sm" disabled={syncing} onClick={syncNow}>{syncing ? 'Syncing…' : '↻ Sync now'}</button>
      </div>
      <nav class="inv-tabs">
        {TABS.map(t => (
          <button key={t.id} class={`inv-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}{t.badge !== undefined && <span class={`tab-badge ${t.warn ? 'warn' : ''}`}>{t.badge}</span>}
          </button>
        ))}
      </nav>
      {tab === 'items' && <ItemsTab items={items} parts={parts} onItem={replaceItem} colours={storeColours} />}
      {tab === 'parts' && <PartsTab parts={parts} models={models} onPart={replacePart} reload={loadParts} stock={stock} colours={storeColours} />}
      {tab === 'queue' && <QueueTab />}
      {tab === 'colours' && <ColourTable />}
      {tab === 'jobs' && <JobsTab />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Store items

const PRIORITIES: [number, string][] = [[1, 'High'], [0, 'Normal'], [-1, 'Low']];
function PrioritySelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select class={`prio prio-${value}`} value={String(value)} title="Print priority"
      onChange={(e: any) => onChange(Number(e.currentTarget.value))}>
      {PRIORITIES.map(([v, l]) => <option value={String(v)}>{l}</option>)}
    </select>
  );
}

type ItemFilter = 'all' | 'managed' | 'short' | 'norecipe';

function ItemsTab({ items, parts, onItem, colours }: { items: StoreItem[] | null; parts: Part[]; onItem: (i: StoreItem) => void; colours: string[] }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!items) return <p class="muted">Loading…</p>;
  if (!items.length) return <p class="muted">No store items yet. Click “Sync now”.</p>;
  const isShort = (i: StoreItem) => i.enabled && i.storeQty < i.minQty;
  const pass = (i: StoreItem) => filter === 'all' || (filter === 'managed' && i.enabled)
    || (filter === 'short' && isShort(i)) || (filter === 'norecipe' && i.enabled && !i.recipe.length);
  const shown = items.filter(i => pass(i) && (!q || `${i.reference} ${i.label}`.toLowerCase().includes(q.toLowerCase())));
  const products = [...new Map(shown.map(i => [i.productId, i.productName])).entries()];
  const toggle = (pid: number) => setOpen(s => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });
  const setAll = async (pid: number, enabled: boolean) => {
    for (const i of items.filter(x => x.productId === pid && x.enabled !== enabled)) onItem(await api.updateItem(i, { enabled }));
  };
  const n = (f: ItemFilter) => items.filter(i => f === 'all' || (f === 'managed' && i.enabled) || (f === 'short' && isShort(i)) || (f === 'norecipe' && i.enabled && !i.recipe.length)).length;
  const FILTERS: [ItemFilter, string][] = [['all', 'All'], ['managed', 'Managed'], ['short', 'Below minimum'], ['norecipe', 'No recipe']];

  return (
    <>
      <div class="inv-toolbar">
        <input class="inv-search" placeholder="Search name or reference…" value={q} onInput={(e: any) => setQ(e.currentTarget.value)} />
        <div class="seg">
          {FILTERS.map(([f, label]) => <button key={f} class={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{label} <span>{n(f)}</span></button>)}
        </div>
      </div>
      <p class="inv-hint-line">Tick the variants to keep in stock, set a minimum and a recipe (the printed parts that make one).</p>
      {products.map(([pid, name]) => {
        const rows = shown.filter(i => i.productId === pid);
        const all = items.filter(i => i.productId === pid);
        const man = all.filter(i => i.enabled).length;
        const shortN = all.filter(isShort).length;
        const isOpen = open.has(pid) || !!q || filter !== 'all';
        return (
          <div class={`inv-product ${isOpen ? 'open' : ''}`} key={pid}>
            <div class="inv-prow" onClick={() => toggle(pid)}>
              <span class="caret">{isOpen ? '▾' : '▸'}</span>
              <span class="pname-l">{name}</span>
              <span class="pill">{all.length} variant{all.length === 1 ? '' : 's'}</span>
              {man > 0 && <span class="pill pill-on">{man} managed</span>}
              {shortN > 0 && <span class="pill pill-warn">{shortN} below min</span>}
              <div class="spacer" />
              {isOpen && (
                <span class="prow-tools" onClick={(e) => e.stopPropagation()}>
                  {all[0]?.hasStoreColour && (
                    <label class="inv-check" title="Off: the store's colour option is ignored for printing (any colour, or the variant's “Print in” choice)">
                      <input type="checkbox" checked={!all[0].ignoreStoreColour}
                        onChange={async (e: any) => { try { for (const u of await api.updateProduct(pid, { ignoreStoreColour: !e.currentTarget.checked })) onItem(u); } catch (err) { fail('Saving')(err); } }} />
                      Print in store colour
                    </label>
                  )}
                  {all.length > 1 && <><button class="chip" onClick={() => setAll(pid, true).catch(fail('Saving'))}>Manage all</button>
                    <button class="chip" onClick={() => setAll(pid, false).catch(fail('Saving'))}>None</button></>}
                </span>
              )}
            </div>
            {isOpen && (
              <div class="table-wrap">
                <table class="inv-table">
                  <thead><tr><th class="c-check" /><th>Variant</th><th>Reference</th><th class="c-num">Stock / min</th><th>Priority</th><th>Recipe</th><th /></tr></thead>
                  <tbody>{rows.map(i => <ItemRow key={`${i.productId}-${i.combinationId}`} item={i} parts={parts} onItem={onItem} colours={colours} />)}</tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {!products.length && <p class="muted">Nothing matches.</p>}
    </>
  );
}

function ItemRow({ item: i, parts, onItem, colours }: { item: StoreItem; parts: Part[]; onItem: (i: StoreItem) => void; colours: string[] }) {
  const [editing, setEditing] = useState(false);
  const partName = (id: number) => parts.find(p => p.id === id)?.name || `part ${id}`;
  const short = i.enabled && i.storeQty < i.minQty;
  return (
    <>
      <tr class={`${i.enabled ? 'on' : 'off'} ${!i.inStore ? 'gone' : ''}`}>
        <td class="c-check"><input type="checkbox" title="Keep this variant in stock" checked={i.enabled}
          onChange={(e: any) => api.updateItem(i, { enabled: e.currentTarget.checked }).then(onItem).catch(fail('Saving'))} /></td>
        <td>
          <div class="opts">{i.options.length ? i.options.map(o => <span class="opt" title={o.group}>{o.value}</span>) : <span class="muted">—</span>}</div>
          {!i.inStore && <div class="inv-err small">No longer in the store</div>}
        </td>
        <td><code class="ref">{i.reference || '—'}</code></td>
        <td class="c-num">
          <span class={`stock ${short ? 'short' : ''}`}>{i.storeQty}</span>
          {i.enabled
            ? <> / <EditField type="number" min={0} class="inv-num" value={i.minQty} onSave={v => api.updateItem(i, { minQty: Number(v) || 0 }).then(onItem).catch(fail('Saving'))} />
                {short && <span class={`pill ${i.storeQty <= 0 ? 'pill-out' : 'pill-warn'}`}>{i.storeQty <= 0 ? 'out' : `−${i.minQty - i.storeQty}`}</span>}</>
            : null}
        </td>
        <td>{i.enabled && <PrioritySelect value={i.priority} onChange={v => api.updateItem(i, { priority: v }).then(onItem).catch(fail('Saving'))} />}</td>
        <td>
          {i.enabled && (i.recipe.length
            ? <div class="opts">{i.recipe.map(r => <span class="opt part">{r.qty}× {partName(r.partId)}</span>)}
                <span class={`opt colour ${i.colour ? '' : 'any'}`}>{i.colour || 'any colour'}</span></div>
            : <span class="inv-warn small">No recipe</span>)}
        </td>
        <td class="c-act">{i.enabled && <button class="chip" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>}</td>
      </tr>
      {editing && (
        <tr class="editor-row"><td /><td colSpan={6}>
          <RecipeEditor item={i} parts={parts} colours={colours} onSaved={(u) => { onItem(u); setEditing(false); }} />
        </td></tr>
      )}
    </>
  );
}

function RecipeEditor({ item, parts, colours, onSaved }: { item: StoreItem; parts: Part[]; colours: string[]; onSaved: (i: StoreItem) => void }) {
  const [rows, setRows] = useState(item.recipe.map(r => ({ ...r })));
  const [colour, setColour] = useState(item.defaultColour);
  const [add, setAdd] = useState('');
  const unused = parts.filter(p => !rows.some(r => r.partId === p.id));
  return (
    <div class="inv-recipe">
      {!parts.length && <p class="muted">No printed parts yet: add them in the “Printed parts” tab first.</p>}
      {rows.map((r, k) => (
        <div class="row" key={r.partId}>
          <input type="number" min={1} class="inv-num" value={r.qty}
            onInput={(e: any) => setRows(rows.map((x, j) => j === k ? { ...x, qty: Number(e.currentTarget.value) } : x))} />
          <span>× {parts.find(p => p.id === r.partId)?.name}</span>
          <button class="chip" onClick={() => setRows(rows.filter((_, j) => j !== k))}>Remove</button>
        </div>
      ))}
      {unused.length > 0 && (
        <div class="row">
          <select value={add} onChange={(e: any) => setAdd(e.currentTarget.value)}>
            <option value="">Add a part…</option>
            {unused.map(p => <option value={p.id}>{p.name}</option>)}
          </select>
          <button class="chip" disabled={!add} onClick={() => { setRows([...rows, { partId: Number(add), qty: 1 }]); setAdd(''); }}>Add</button>
        </div>
      )}
      {item.colourFromStore
        ? <p class="muted">Colour: <b>{item.colour}</b> (from the store variant)</p>
        : (
          <label class="muted">Print in{' '}
            {item.hasStoreColour && <span>The store colour isn't used for this product. </span>}
            <select value={colour} onChange={(e: any) => setColour(e.currentTarget.value)}>
              <option value="">Any colour (whatever is loaded)</option>
              {colours.map(c => <option value={c}>{c}</option>)}
            </select>
            {' '}{!item.hasStoreColour && <span>This store item has no colour option, so choose it here.</span>}
          </label>
        )}
      <button class="btn btn-sm btn-primary" onClick={async () => {
        try {
          if (!item.colourFromStore && colour !== item.defaultColour) await api.updateItem(item, { defaultColour: colour });
          onSaved(await api.setRecipe(item, rows.filter(r => r.qty > 0)));
        } catch (e) { fail('Saving recipe')(e); }
      }}>Save recipe</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printed parts

function PartsTab({ parts, models, onPart, reload, stock, colours }: { parts: Part[]; models: PrinterModel[]; onPart: (p: Part) => void; reload: () => void;
  stock: { partId: number; colour: string; qty: number }[]; colours: string[] }) {
  const [name, setName] = useState(''); const [material, setMaterial] = useState('');
  const [q, setQ] = useState('');
  const create = () => api.addPart({ name: name.trim(), material: material.trim() })
    .then(() => { setName(''); setMaterial(''); reload(); }).catch(fail('Adding the part'));
  const sorted = useMemo(() => [...parts].sort((a, b) => a.name.localeCompare(b.name)), [parts]);
  const shown = sorted.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div class="inv-toolbar">
        <input class="inv-search" placeholder="Search parts…" value={q} onInput={(e: any) => setQ(e.currentTarget.value)} />
        <div class="newpart">
          <input placeholder="New part name" value={name} onInput={(e: any) => setName(e.currentTarget.value)} />
          <input class="inv-mat" placeholder="Material" value={material} onInput={(e: any) => setMaterial(e.currentTarget.value)} />
          <button class="btn btn-sm btn-primary" disabled={!name.trim()} onClick={create}>Add part</button>
        </div>
      </div>
      <p class="inv-hint-line">Each file has its own units per plate (a 1-up and a 3-up layout, or a bigger K2 plate); the biggest layout that doesn't overshoot is used. Files sliced for another model are flagged ⚠️.</p>
      {!sorted.length && <p class="inv-hint">No parts yet. Add one above, then add its G-code files.</p>}
      <div class="part-grid">
        {shown.map(p => <PartCard key={p.id} part={p} models={models} onPart={onPart} reload={reload} stock={stock.filter(x => x.partId === p.id)} colours={colours} />)}
      </div>
    </>
  );
}

function PartCard({ part: p, models, onPart, reload, stock, colours }: { part: Part; models: PrinterModel[]; onPart: (p: Part) => void; reload: () => void;
  stock: { colour: string; qty: number }[]; colours: string[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editStock, setEditStock] = useState(false);
  const [addModel, setAddModel] = useState(models[0]?.model ?? '');
  const [addUnits, setAddUnits] = useState('1');
  useEffect(() => { if (!addModel && models[0]) setAddModel(models[0].model); }, [models]);
  const onHand = stock.filter(x => x.qty > 0);
  const save = (patch: any) => api.updatePart(p.id, patch).then(onPart).catch(fail('Saving'));
  const warnAfter = (u: Part, fileId?: number) => {
    const f = fileId ? u.files.find(x => x.id === fileId) : [...u.files].sort((a, b) => b.id - a.id)[0];
    if (f?.meta.warnings.length) alert(`Uploaded, but check this:\n\n${f.meta.warnings.join('\n')}`);
  };
  const run = (key: string, p2: Promise<Part>, fileId?: number) => {
    setBusy(key);
    p2.then(u => { onPart(u); warnAfter(u, fileId); }).catch(fail('Upload')).finally(() => setBusy(null));
  };
  const modelName = (m: string) => models.find(x => x.model === m)?.name || p.files.find(f => f.model === m)?.modelName || m;
  const files = [...p.files].sort((a, b) => a.model.localeCompare(b.model) || b.unitsPerPlate - a.unitsPerPlate);
  return (
    <div class="part-card">
      <div class="part-head">
        <EditField class="inv-pname" value={p.name} onSave={v => v ? save({ name: v }) : alert('A part needs a name.')} />
        <EditField class="inv-mat" placeholder="Material" value={p.material} onSave={v => save({ material: v })} />
        <button class="icon-chip" title="Delete this part" onClick={() => confirm(`Delete “${p.name}” and its G-code files?`) && api.deletePart(p.id).then(reload).catch(fail('Deleting'))}>🗑</button>
      </div>
      <div class="part-onhand">
        <span class="muted small">On hand</span>
        {onHand.length ? onHand.map(x => <span class="opt colour">{x.qty} {x.colour || 'any colour'}</span>) : <span class="muted small">none</span>}
        <button class="chip" onClick={() => setEditStock(!editStock)}>{editStock ? 'Done' : 'Edit'}</button>
      </div>
      {editStock && (
        <div class="inv-stock">
          {['', ...colours].map(c => (
            <label class="muted small">{c || 'No colour'}{' '}
              <EditField type="number" min={0} class="inv-num" value={stock.find(x => x.colour === c)?.qty ?? 0}
                onSave={v => api.setPartStock(p.id, c, Number(v) || 0).then(reload).catch(fail('Saving'))} />
            </label>
          ))}
        </div>
      )}
      <div class="table-wrap"><table class="inv-table files">
        <thead><tr><th>Model</th><th class="c-num">Per plate</th><th>File</th><th /></tr></thead>
        <tbody>
          {files.map(f => (
            <tr key={f.id}>
              <td><b>{modelName(f.model)}</b></td>
              <td class="c-num"><EditField type="number" min={1} class="inv-num" value={f.unitsPerPlate}
                onSave={v => api.setFileUnits(p.id, f.id, Number(v)).then(onPart).catch(fail('Saving'))} /></td>
              <td class="c-file" title={[f.filename, ...f.meta.warnings].join('\n')}>
                <span class={f.meta.warnings.length ? 'inv-warn' : 'ok'}>{f.meta.warnings.length ? '⚠️' : '✓'}</span> {f.filename}
                <div class="muted small">{[f.meta.printTime, f.meta.filamentType, kb(f.size)].filter(Boolean).join(' · ')}</div>
              </td>
              <td class="c-act">
                <label class="chip">{busy === `r${f.id}` ? '…' : 'Replace'}
                  <input type="file" accept=".gcode,.g,.gco" hidden onChange={(e: any) => { const fl = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (fl) run(`r${f.id}`, api.replaceFile(p.id, f.id, fl), f.id); }} />
                </label>
                <button class="icon-chip" title="Remove this file" onClick={() => confirm(`Remove ${f.filename}?`) && api.deleteFile(p.id, f.id).then(onPart).catch(fail('Removing'))}>✕</button>
              </td>
            </tr>
          ))}
          {!files.length && <tr><td colSpan={4} class="muted small">No G-code yet.</td></tr>}
        </tbody>
      </table></div>
      <div class="add-file">
        <select value={addModel} onChange={(e: any) => setAddModel(e.currentTarget.value)}>
          {models.map(m => <option value={m.model}>{m.name}</option>)}
        </select>
        <label class="muted small"><input type="number" min={1} class="inv-num" value={addUnits} onInput={(e: any) => setAddUnits(e.currentTarget.value)} /> per plate</label>
        <label class="chip chip-primary">{busy === 'add' ? 'Uploading…' : '＋ Add file'}
          <input type="file" accept=".gcode,.g,.gco" hidden disabled={!addModel} onChange={(e: any) => { const fl = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (fl && addModel) run('add', api.addFile(p.id, addModel, Math.max(1, Number(addUnits) || 1), fl)); }} />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue

function QueueTab() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const load = () => api.plan().then(setPlan).catch(fail('Loading the plan'));
  useEffect(() => { load(); }, []);
  if (!plan) return <p class="muted">Working out the plan…</p>;
  const ready = plan.printers.filter(p => p.ready).map(p => p.name);
  const setPrio = (i: Plan['items'][number], v: number) => api.updateItem(i, { priority: v }).then(load).catch(fail('Saving'));
  // Print order: consecutive identical plates collapse into one numbered row (#2–4).
  type Row = { from: number; to: number; j: Plan['jobs'][number] };
  const rows: Row[] = [];
  plan.jobs.forEach((j, k) => {
    const last = rows[rows.length - 1];
    const same = last && last.j.partId === j.partId && last.j.colour === j.colour && last.j.stage === j.stage
      && last.j.unitsPerPlate === j.unitsPerPlate && last.j.priority === j.priority
      && (last.j.printer?.id ?? null) === (j.printer?.id ?? null) && last.j.reason === j.reason && !j.printer;
    if (same) last.to = k + 1; else rows.push({ from: k + 1, to: k + 1, j });
  });
  const outN = plan.items.filter(i => i.outOfStock).length;
  return (
    <>
      <div class="tiles">
        <div class={`tile2 ${outN ? 'bad' : ''}`}><span class="n">{outN}</span><span class="l">out of stock</span></div>
        <div class="tile2"><span class="n">{plan.items.length}</span><span class="l">items below minimum</span></div>
        <div class="tile2"><span class="n">{plan.jobs.length}</span><span class="l">plates to print</span></div>
        <div class={`tile2 ${ready.length ? 'good' : ''}`}><span class="n">{ready.length}</span><span class="l">{ready.length ? `ready: ${ready.join(', ')}` : 'printers ready'}</span></div>
        <button class="chip" onClick={load}>↻ Refresh</button>
      </div>
      <p class="inv-hint-line">Print order: <b>High</b> priority first, then one of each <b>out-of-stock</b> item, then the rest up to the minimum (furthest below first). Free printers take plates from the top. Printers only get plates when <b>Auto-load</b> is on (Jobs tab).</p>

      <h3 class="inv-h3">Print order</h3>
      {!rows.length ? <p class="muted">Nothing to print.</p> : (
        <div class="table-wrap"><table class="inv-table">
          <thead><tr><th class="c-num">#</th><th>Part</th><th>Filament</th><th class="c-num">Units</th><th>Why</th><th>Where / waiting for</th></tr></thead>
          <tbody>{rows.map((r, k) => (
            <tr key={k} class={k === 0 ? 'next' : ''} title={`For ${r.j.forItems.join(', ')}`}>
              <td class="c-num">{k === 0 ? <span class="pill pill-next">Next</span> : <span class="muted">{r.from === r.to ? r.from : `${r.from}–${r.to}`}</span>}</td>
              <td><b>{r.j.part}</b>{r.to > r.from && <span class="muted small"> × {r.to - r.from + 1} plates</span>}
                <div class="muted small">for {r.j.forItems.join(', ')}</div></td>
              <td><span class={`opt colour ${r.j.colour ? '' : 'any'}`}>{[r.j.material, r.j.colour || 'any colour'].filter(Boolean).join(' ')}</span></td>
              <td class="c-num">{r.j.unitsPerPlate * (r.to - r.from + 1)}</td>
              <td>
                {r.j.priority > 0 && <span class="pill pill-high">High</span>}
                {r.j.priority < 0 && <span class="pill">Low</span>}
                {r.j.stage === 'out' ? <span class="pill pill-out">Out of stock</span> : <span class="pill pill-warn">Below min</span>}
              </td>
              <td>{r.j.printer ? <span class="go">→ {r.j.printer.name}</span> : <span class="why muted small">{r.j.reason}</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <h3 class="inv-h3">Below minimum</h3>
      {!plan.items.length ? <p class="muted">Every managed item is at or above its minimum.</p> : (
        <div class="table-wrap"><table class="inv-table">
          <thead><tr><th>Reference</th><th class="c-num">In store</th><th class="c-num">Min</th><th class="c-num">Short</th><th>Priority</th><th /></tr></thead>
          <tbody>{plan.items.map(i => (
            <tr key={`${i.productId}-${i.combinationId}`}><td><code class="ref">{i.reference}</code></td>
              <td class="c-num">{i.outOfStock ? <span class="pill pill-out">0</span> : i.storeQty}</td><td class="c-num">{i.minQty}</td>
              <td class="c-num"><span class="pill pill-warn">{i.short}</span></td>
              <td><PrioritySelect value={i.priority} onChange={v => setPrio(i, v)} /></td>
              <td>{i.problems.length > 0 && <span class="inv-warn small">⚠️ {i.problems.join(', ')}</span>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function ColourTable({ onChange }: { onChange?: () => void }) {
  const [colours, setColours] = useState<{ map: Record<string, string>; storeColours: string[] } | null>(null);
  useEffect(() => { api.colours().then(setColours).catch(fail('Loading colours')); }, []);
  const save = (name: string, hex: string) => colours && api.setColours({ ...colours.map, [name]: hex })
    .then(c => { setColours(c); onChange?.(); }).catch(fail('Saving the colour'));
  return (
    <>
      <h3 class="inv-h3">Colour table</h3>
      <p class="muted" style="margin-bottom:8px">Printers report spool colours as codes. Click a swatch and pick the filament colour you load for that store colour.</p>
      <div class="q-colours">
        {colours?.storeColours.map(name => (
          <label class="q-colour">
            <input type="color" value={colours.map[name] || '#888888'} onChange={(e: any) => save(name, e.currentTarget.value)} />
            {name}{!colours.map[name] && <span class="inv-warn"> (not set)</span>}
          </label>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

const STATUS: Record<StoreJob['status'], string> = {
  loading: '⏳ loading', loaded: '📦 loaded: clear the bed and start', printing: '🖨️ printing', printed: '✅ printed: check it',
  completed: '✔️ completed', failed: '❌ failed', cancelled: '— cancelled',
};
export function jobLabel(j: StoreJob) { return `${j.part} (${j.units}${j.colour ? ` · ${j.colour}` : ''})`; }

export function JobActions({ j, onDone }: { j: StoreJob; onDone: (s: JobsState) => void }) {
  const act = (a: 'complete' | 'failed' | 'cancel' | 'start', ask?: string) => {
    if (ask && !confirm(ask)) return;
    api.jobAction(j.id, a).then(onDone).catch(fail('Job'));
  };
  return (
    <span class="job-actions">
      {j.status === 'loaded' && <button class="chip" onClick={() => act('start', `Start ${j.file} on ${j.printer}? Make sure the bed is clear.`)}>▶ Start</button>}
      {j.status === 'loaded' && <button class="chip" onClick={() => act('cancel', 'Cancel this job? It is planned again if the item is still short.')}>Cancel</button>}
      {j.status === 'printed' && <button class="chip chip-ok" onClick={() => act('complete', `Is ${jobLabel(j)} good? This adds it to parts on hand (and the store, when complete sets exist).`)}>Complete</button>}
      {(j.status === 'printed' || j.status === 'printing') && <button class="chip" onClick={() => act('failed', 'Mark this print as failed? It will be printed again.')}>Failed</button>}
    </span>
  );
}

function JobsTab() {
  const [st, setSt] = useState<JobsState | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [allUpdates, setAllUpdates] = useState(false);
  const load = () => api.storeJobs().then(setSt).catch(fail('Loading jobs'));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  if (!st) return <p class="muted">Loading…</p>;
  const set = (patch: { autoLoad?: boolean; liveWrites?: boolean }, ask: string) => { if (confirm(ask)) api.jobSettings(patch).then(setSt).catch(fail('Saving')); };
  const active = st.jobs.filter(j => ['loading', 'loaded', 'printing', 'printed'].includes(j.status));
  const done = st.jobs.filter(j => !active.includes(j));
  const when = (t: number | null) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <>
      <div class="switch-panel">
        <label class={`switch-row ${st.autoLoad ? 'on' : ''}`}>
          <input type="checkbox" checked={st.autoLoad} onChange={(e: any) => { const on = e.currentTarget.checked; e.currentTarget.checked = st.autoLoad;
            set({ autoLoad: on }, on ? 'Turn on auto-load? Planned plates are put on ready printers (uploaded if the file isn\'t there yet). Printing still needs you to start it.' : 'Turn off auto-load? Nothing new is sent to printers.'); }} />
          <div><b>Auto-load jobs</b><div class="muted small">{st.autoLoad ? 'On: ready printers get their next plate' : 'Off: plan only, nothing is sent to printers'}</div></div>
        </label>
        <label class={`switch-row ${st.liveWrites ? 'on' : ''}`}>
          <input type="checkbox" checked={st.liveWrites} onChange={(e: any) => { const on = e.currentTarget.checked; e.currentTarget.checked = st.liveWrites;
            set({ liveWrites: on }, on ? 'Turn on live store updates? Completed sets will raise the stock on store.onicindustries.com.' : 'Back to dry run? Store stock changes are only logged.'); }} />
          <div><b>Store stock updates</b><div class="muted small">{st.liveWrites ? 'Live: completed sets raise the store stock' : 'Dry run: changes are only logged'}</div></div>
        </label>
        <button class="btn btn-sm" disabled={!st.autoLoad} onClick={() => api.dispatchNow().then(setSt).catch(fail('Loading jobs'))}>Load now</button>
      </div>

      <h3 class="inv-h3">Active jobs</h3>
      {!active.length ? <p class="muted">None.</p> : (
        <div class="table-wrap"><table class="inv-table">
          <thead><tr><th>Printer</th><th>Plate</th><th>Status</th><th>File</th><th /></tr></thead>
          <tbody>{active.map(j => (
            <tr key={j.id} class={`job-${j.status}`} title={`For ${j.forItems.join(', ')}`}>
              <td><b>{j.printer}</b></td><td>{jobLabel(j)}</td><td><span class={`pill job-pill-${j.status}`}>{STATUS[j.status]}</span></td>
              <td class="c-file muted small">{j.file}</td><td class="c-act"><JobActions j={j} onDone={setSt} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <h3 class="inv-h3">Store stock changes{st.liveWrites ? '' : ' (dry run)'}</h3>
      {!st.updates.length ? <p class="muted">None yet: they appear when completed parts make full sets.</p> : (
        <div class="table-wrap"><table class="inv-table">
          <thead><tr><th>When</th><th>Reference</th><th class="c-num">Stock</th><th>Used</th></tr></thead>
          <tbody>{(allUpdates ? st.updates : st.updates.slice(0, 6)).map(u => (
            <tr key={u.id} class={u.error ? 'job-failed' : ''}>
              <td class="muted small">{when(u.at)}</td><td><code class="ref">{u.reference}</code></td>
              <td class="c-num">{u.error ? <span class="inv-err small">❌ {u.error}</span> : <>{u.before} → <b>{u.after}</b>{u.dryRun && <span class="pill">dry run</span>}</>}</td>
              <td class="muted small">{u.parts}</td>
            </tr>
          ))}</tbody>
        </table>
        {st.updates.length > 6 && <button class="chip" onClick={() => setAllUpdates(!allUpdates)}>{allUpdates ? 'Show fewer' : `Show all ${st.updates.length}`}</button>}
        </div>
      )}

      <h3 class="inv-h3 clickable" onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Recent jobs ({done.length})</h3>
      {showDone && (done.length ? (
        <div class="table-wrap"><table class="inv-table">
          <thead><tr><th>When</th><th>Printer</th><th>Plate</th><th>Result</th></tr></thead>
          <tbody>{done.map(j => (
            <tr key={j.id}><td class="muted small">{when(j.endedAt || j.createdAt)}</td><td>{j.printer}</td><td>{jobLabel(j)}</td>
              <td class="muted small">{STATUS[j.status]}{j.note ? ` · ${j.note}` : ''}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <p class="muted">None yet.</p>)}
    </>
  );
}
