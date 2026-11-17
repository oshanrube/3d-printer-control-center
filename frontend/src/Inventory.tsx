// Store inventory (phase 1): the store's items with minimum stock and recipes, and the printed
// parts with their G-code per printer model. Read-only towards the store.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Part, type Plan, type PrinterModel, type StoreItem, type SyncStatus } from './api';

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
const kb = (n: number) => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
const fail = (what: string) => (e: any) => alert(`${what}: ${e?.message || e}`);

export function InventoryModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'items' | 'parts' | 'queue'>('items');
  const [items, setItems] = useState<StoreItem[] | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [models, setModels] = useState<PrinterModel[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [stock, setStock] = useState<{ partId: number; colour: string; qty: number }[]>([]);
  const [storeColours, setStoreColours] = useState<string[]>([]);

  const loadItems = () => api.storeItems().then(r => { setItems(r.items); setStatus(r.status); }).catch(fail('Loading store items'));
  const loadParts = () => { api.parts().then(setParts).catch(fail('Loading parts')); api.partStock().then(setStock).catch(() => {}); };
  useEffect(() => { loadItems(); loadParts(); api.models().then(setModels).catch(() => {}); api.colours().then(c => setStoreColours(c.storeColours)).catch(() => {}); }, []);

  const syncNow = async () => {
    setSyncing(true);
    try { const r = await api.storeSync('manual'); setItems(r.items); setStatus(r.status); }
    catch (e: any) { fail('Sync')(e); } finally { setSyncing(false); }
  };
  const replaceItem = (u: StoreItem) => setItems(xs => xs && xs.map(x => x.productId === u.productId && x.combinationId === u.combinationId ? u : x));
  const replacePart = (u: Part) => setParts(ps => ps.map(p => p.id === u.id ? u : p));

  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-box inv">
        <div class="inv-head">
          <h2>📦 Store inventory</h2>
          <div class="spacer" />
          <span class={`muted ${status?.lastError ? 'inv-err' : ''}`} title={status?.lastError || ''}>
            {status?.lastError ? `⚠️ Last sync failed (${ago(status.lastAttemptAt)}): ${status.lastError}` : `Synced ${ago(status?.lastSyncAt ?? null)} · ${status?.items ?? 0} items`}
          </span>
          <button class="btn btn-sm" disabled={syncing} onClick={syncNow}>{syncing ? 'Syncing…' : '↻ Sync now'}</button>
          <button class="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
        <div class="row" style="margin-bottom:12px">
          <button class={`btn btn-sm ${tab === 'items' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('items')}>Store items</button>
          <button class={`btn btn-sm ${tab === 'parts' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('parts')}>Printed parts ({parts.length})</button>
          <button class={`btn btn-sm ${tab === 'queue' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('queue')}>Queue (dry run)</button>
        </div>
        {tab === 'items' && <ItemsTab items={items} parts={parts} onItem={replaceItem} />}
        {tab === 'parts' && <PartsTab parts={parts} models={models} onPart={replacePart} reload={loadParts} stock={stock} colours={storeColours} />}
        {tab === 'queue' && <QueueTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ItemsTab({ items, parts, onItem }: { items: StoreItem[] | null; parts: Part[]; onItem: (i: StoreItem) => void }) {
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!items) return <p class="muted">Loading…</p>;
  if (!items.length) return <p class="muted">No store items yet. Click “Sync now”.</p>;

  const shown = items.filter(i => (!onlyEnabled || i.enabled) &&
    (!q || `${i.reference} ${i.label}`.toLowerCase().includes(q.toLowerCase())));
  const products = [...new Map(shown.map(i => [i.productId, i.productName])).entries()];
  const toggle = (pid: number) => setOpen(s => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });
  const setAll = async (pid: number, enabled: boolean) => {
    for (const i of items.filter(x => x.productId === pid && x.enabled !== enabled)) onItem(await api.updateItem(i, { enabled }));
  };

  return (
    <>
      <div class="row inv-filters">
        <input class="inv-search" placeholder="Search name or reference…" value={q} onInput={(e: any) => setQ(e.currentTarget.value)} />
        <label class="inv-check"><input type="checkbox" checked={onlyEnabled} onChange={(e: any) => setOnlyEnabled(e.currentTarget.checked)} /> Managed only</label>
      </div>
      <p class="muted" style="margin-bottom:10px">Turn on the items the printers should keep in stock, set the minimum, and say which printed parts make one.</p>
      {products.map(([pid, name]) => {
        const rows = shown.filter(i => i.productId === pid);
        const all = items.filter(i => i.productId === pid);
        const managed = all.filter(i => i.enabled).length;
        const isOpen = open.has(pid) || !!q;
        return (
          <div class="inv-product">
            <div class="inv-prow" onClick={() => toggle(pid)}>
              <span>{isOpen ? '▾' : '▸'}</span>
              <b>{name}</b>
              <span class="muted">{all.length > 1 || all[0]?.combinationId ? `${all.length} variants` : all[0]?.reference}{managed ? ` · ${managed} managed` : ''}</span>
              <div class="spacer" />
              {isOpen && all.length > 1 && (
                <span onClick={(e) => e.stopPropagation()}>
                  <button class="chip" onClick={() => setAll(pid, true).catch(fail('Saving'))}>Manage all</button>{' '}
                  <button class="chip" onClick={() => setAll(pid, false).catch(fail('Saving'))}>None</button>
                </span>
              )}
            </div>
            {isOpen && rows.map(i => <ItemRow item={i} parts={parts} onItem={onItem} />)}
          </div>
        );
      })}
      {!products.length && <p class="muted">Nothing matches.</p>}
    </>
  );
}

function ItemRow({ item: i, parts, onItem }: { item: StoreItem; parts: Part[]; onItem: (i: StoreItem) => void }) {
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState(String(i.minQty));
  useEffect(() => setMin(String(i.minQty)), [i.minQty]);
  const partName = (id: number) => parts.find(p => p.id === id)?.name || `part ${id}`;
  const recipe = i.recipe.map(r => `${r.qty}× ${partName(r.partId)}`).join(', ');
  const short = i.storeQty < i.minQty;
  return (
    <div class={`inv-item ${i.enabled ? 'on' : ''} ${!i.inStore ? 'gone' : ''}`}>
      <label class="inv-check" title="Keep this item in stock">
        <input type="checkbox" checked={i.enabled} onChange={(e: any) => api.updateItem(i, { enabled: e.currentTarget.checked }).then(onItem).catch(fail('Saving'))} />
      </label>
      <div class="inv-main">
        <div><code>{i.reference || '(no reference)'}</code>{!i.inStore && <span class="inv-err"> · no longer in the store</span>}</div>
        <div class="muted">{i.options.map(o => o.value).join(' · ') || 'No variants'}</div>
        {i.enabled && (
          <div class={`muted ${i.recipe.length ? '' : 'inv-warn'}`}>
            {i.recipe.length ? `Made of: ${recipe}` : '⚠️ No recipe yet: say which printed parts make one'}{' '}
            <button class="chip" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit recipe'}</button>
          </div>
        )}
        {editing && <RecipeEditor item={i} parts={parts} onSaved={(u) => { onItem(u); setEditing(false); }} />}
      </div>
      <div class="inv-qty">
        <div class={short && i.enabled ? 'inv-warn' : ''} title="Stock in the store">{i.storeQty} <span class="muted">in store</span></div>
        {i.enabled && (
          <label class="muted">min{' '}
            <input type="number" min={0} class="inv-num" value={min} onInput={(e: any) => setMin(e.currentTarget.value)}
              onBlur={() => { if (Number(min) !== i.minQty) api.updateItem(i, { minQty: Number(min) }).then(onItem).catch(fail('Saving')); }} />
          </label>
        )}
      </div>
    </div>
  );
}

function RecipeEditor({ item, parts, onSaved }: { item: StoreItem; parts: Part[]; onSaved: (i: StoreItem) => void }) {
  const [rows, setRows] = useState(item.recipe.map(r => ({ ...r })));
  const [add, setAdd] = useState('');
  const unused = parts.filter(p => !rows.some(r => r.partId === p.id));
  return (
    <div class="inv-recipe">
      {!parts.length && <p class="muted">No printed parts yet: add them in the “Printed parts” tab first.</p>}
      {rows.map((r, k) => (
        <div class="row">
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
      <button class="btn btn-sm btn-primary" onClick={() => api.setRecipe(item, rows.filter(r => r.qty > 0)).then(onSaved).catch(fail('Saving recipe'))}>Save recipe</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PartsTab({ parts, models, onPart, reload, stock, colours }: { parts: Part[]; models: PrinterModel[]; onPart: (p: Part) => void; reload: () => void;
  stock: { partId: number; colour: string; qty: number }[]; colours: string[] }) {
  const [name, setName] = useState(''); const [units, setUnits] = useState('1'); const [material, setMaterial] = useState('');
  const create = () => api.addPart({ name: name.trim(), unitsPerPlate: Number(units) || 1, material: material.trim() })
    .then(() => { setName(''); setUnits('1'); setMaterial(''); reload(); }).catch(fail('Adding the part'));
  const sorted = useMemo(() => [...parts].sort((a, b) => a.name.localeCompare(b.name)), [parts]);
  return (
    <>
      <p class="muted" style="margin-bottom:10px">A printed part is one plate's worth of G-code. Upload a file for each printer model it should print on: files sliced for another model are flagged.</p>
      <div class="inv-newpart row">
        <input placeholder="New part name (e.g. Antler holder V3)" value={name} onInput={(e: any) => setName(e.currentTarget.value)} />
        <label class="muted">per plate <input type="number" min={1} class="inv-num" value={units} onInput={(e: any) => setUnits(e.currentTarget.value)} /></label>
        <input class="inv-mat" placeholder="Material (ABS…)" value={material} onInput={(e: any) => setMaterial(e.currentTarget.value)} />
        <button class="btn btn-sm btn-primary" disabled={!name.trim()} onClick={create}>Add part</button>
      </div>
      {!sorted.length && <p class="muted">No parts yet.</p>}
      {sorted.map(p => <PartCard part={p} models={models} onPart={onPart} reload={reload} stock={stock.filter(x => x.partId === p.id)} colours={colours} />)}
    </>
  );
}

function PartCard({ part: p, models, onPart, reload, stock, colours }: { part: Part; models: PrinterModel[]; onPart: (p: Part) => void; reload: () => void;
  stock: { colour: string; qty: number }[]; colours: string[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editStock, setEditStock] = useState(false);
  const onHand = stock.filter(x => x.qty > 0).map(x => `${x.qty} ${x.colour || 'any colour'}`).join(', ');
  const save = (patch: any) => api.updatePart(p.id, patch).then(onPart).catch(fail('Saving'));
  const upload = (model: string, file?: File) => {
    if (!file) return;
    setBusy(model);
    api.uploadGcode(p.id, model, file).then(u => {
      onPart(u);
      const w = u.gcodes.find(g => g.model === model)?.meta.warnings || [];
      if (w.length) alert(`Uploaded, but check this:\n\n${w.join('\n')}`);
    }).catch(fail('Upload')).finally(() => setBusy(null));
  };
  const slots = [...models.map(m => m.model), ...p.gcodes.map(g => g.model).filter(m => !models.some(x => x.model === m))];
  return (
    <div class="inv-part">
      <div class="row">
        <input class="inv-pname" value={p.name} onBlur={(e: any) => e.currentTarget.value.trim() !== p.name && save({ name: e.currentTarget.value.trim() })} />
        <label class="muted">per plate <input type="number" min={1} class="inv-num" value={p.unitsPerPlate} onBlur={(e: any) => Number(e.currentTarget.value) !== p.unitsPerPlate && save({ unitsPerPlate: Number(e.currentTarget.value) })} /></label>
        <input class="inv-mat" placeholder="Material" value={p.material} onBlur={(e: any) => e.currentTarget.value.trim() !== p.material && save({ material: e.currentTarget.value.trim() })} />
        <span class="muted" title="Printed and checked, not yet used in a store item">on hand: {onHand || 'none'}</span>
        <button class="chip" onClick={() => setEditStock(!editStock)}>{editStock ? 'Done' : 'Edit'}</button>
        <div class="spacer" />
        <button class="chip" onClick={() => confirm(`Delete “${p.name}” and its G-code files?`) && api.deletePart(p.id).then(reload).catch(fail('Deleting'))}>Delete</button>
      </div>
      {editStock && (
        <div class="inv-stock">
          {['', ...colours].map(c => (
            <label class="muted">{c || 'No colour'}{' '}
              <input type="number" min={0} class="inv-num" value={stock.find(x => x.colour === c)?.qty ?? 0}
                onBlur={(e: any) => api.setPartStock(p.id, c, Number(e.currentTarget.value)).then(reload).catch(fail('Saving'))} />
            </label>
          ))}
        </div>
      )}
      {slots.map(model => {
        const g = p.gcodes.find(x => x.model === model);
        const m = models.find(x => x.model === model);
        return (
          <div class="inv-slot">
            <b title={m ? m.printers.join(', ') : 'No printer of this model right now'}>{m?.name || g?.modelName || model}</b>
            {g ? (
              <span class={g.meta.warnings.length ? 'inv-warn' : ''} title={g.meta.warnings.join('\n')}>
                {g.meta.warnings.length ? '⚠️ ' : '✅ '}{g.filename} · {kb(g.size)}{g.meta.printTime ? ` · ${g.meta.printTime}` : ''}
                {g.meta.filamentType ? ` · ${g.meta.filamentType}` : ''}{g.meta.printerModel ? ` · sliced for ${g.meta.printerModel}` : ''}
              </span>
            ) : <span class="muted">No file</span>}
            <div class="spacer" />
            <label class="chip">{busy === model ? 'Uploading…' : g ? 'Replace' : 'Upload'}
              <input type="file" accept=".gcode,.g,.gco" hidden disabled={busy === model} onChange={(e: any) => { upload(model, e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
            </label>
            {g && <button class="chip" onClick={() => confirm(`Remove the ${m?.name || model} file?`) && api.deleteGcode(p.id, model).then(onPart).catch(fail('Removing'))}>Remove</button>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function QueueTab() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [colours, setColours] = useState<{ map: Record<string, string>; storeColours: string[] } | null>(null);
  const load = () => { api.plan().then(setPlan).catch(fail('Loading the plan')); api.colours().then(setColours).catch(() => {}); };
  useEffect(() => { load(); }, []);
  if (!plan) return <p class="muted">Working out the plan…</p>;
  const saveColour = (name: string, hex: string) => colours && api.setColours({ ...colours.map, [name]: hex }).then(c => { setColours(c); load(); }).catch(fail('Saving the colour'));
  const ready = plan.printers.filter(p => p.ready).map(p => p.name);
  return (
    <>
      <p class="muted" style="margin-bottom:10px"><b>Dry run:</b> this is what the controller would load and where. Nothing is sent to the printers yet.
        {' '}Printers ready for a job: {ready.length ? ready.join(', ') : 'none (turn on “Store jobs” on a printer card and confirm its bed is clear)'}.
        {' '}<button class="chip" onClick={load}>↻ Refresh</button></p>

      <h3 class="inv-h3">Below minimum</h3>
      {!plan.items.length && <p class="muted">Every managed item is at or above its minimum.</p>}
      {plan.items.map(i => (
        <div class="q-row"><code>{i.reference}</code><span>{i.storeQty} in store, min {i.minQty}: <b>{i.short} short</b></span>
          {i.problems.length > 0 && <span class="inv-warn">⚠️ {i.problems.join(', ')}</span>}</div>
      ))}

      <h3 class="inv-h3">Plates to print ({plan.jobs.length})</h3>
      {!plan.jobs.length && <p class="muted">Nothing to print.</p>}
      {plan.jobs.map(j => (
        <div class={`q-row ${j.printer ? 'q-go' : ''}`}>
          <b>{j.part}</b>
          <span class="muted">{[j.material, j.colour].filter(Boolean).join(' ')} · {j.unitsPerPlate} per plate · for {j.forItems.join(', ')}</span>
          <span>{j.printer ? `→ would load on ${j.printer.name}` : <span class="inv-warn">{j.reason}</span>}</span>
        </div>
      ))}

      <h3 class="inv-h3">Colour table</h3>
      <p class="muted" style="margin-bottom:8px">Printers report spool colours as codes: match each store colour to the filament colour you load for it.</p>
      <div class="q-colours">
        {colours?.storeColours.map(name => (
          <label class="q-colour">
            <input type="color" value={colours.map[name] || '#888888'} onChange={(e: any) => saveColour(name, e.currentTarget.value)} />
            {name}{!colours.map[name] && <span class="inv-warn"> (not set)</span>}
          </label>
        ))}
      </div>
    </>
  );
}
