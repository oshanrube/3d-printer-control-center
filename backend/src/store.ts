import { config } from './config.js';

/**
 * Read-only client for the PrestaShop webservice (https://store.onicindustries.com/api).
 * The controller uses this to keep the store's stock levels topped up.
 * Items are keyed by (productId, combinationId): stable, unlike references.
 */

export interface StoreOption { group: string; value: string }

export interface StoreItem {
  productId: number;
  combinationId: number;   // 0 for products without combinations
  reference: string;       // combination reference, or the product reference when there are no combinations
  productName: string;
  options: StoreOption[];  // sorted by the option group id; empty when no combinations
  quantity: number;        // from stock_availables (id_product + id_product_attribute)
}

export function itemLabel(i: StoreItem): string {
  return i.productName + (i.options.length ? ' — ' + i.options.map(o => o.value).join(', ') : '');
}

// PrestaShop returns multilingual fields as [{id, value}] and ids as numbers or strings.
function text(v: any): string {
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]?.value ?? '') : String(v ?? '');
}

async function get(resource: string, display: string): Promise<any[]> {
  if (!config.store.apiKey) throw new Error('STORE_API_KEY is not set');
  // display holds [ , ] which must reach PrestaShop literally.
  const url = `${config.store.url}/api/${resource}?output_format=JSON&display=${display}&limit=1000`;
  // Network failures are retried: the Pi's DNS lookups intermittently time out (2026-11-17).
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${config.store.apiKey}:`).toString('base64')}` },
        signal: AbortSignal.timeout(60_000),
      });
      break;
    } catch (e: any) {
      if (attempt >= 2) {
        const cause = e?.cause?.code || e?.cause?.message || '';
        throw new Error(`can't reach the store (${resource})${cause ? `: ${/EAI_AGAIN|ENOTFOUND/.test(cause) ? `DNS lookup failed (${cause})` : cause}` : `: ${e?.message || e}`}`);
      }
      await new Promise(r => setTimeout(r, attempt ? 8000 : 3000));
    }
  }
  if (!res.ok) throw new Error(`store ${resource}: HTTP ${res.status}`);
  const body: any = await res.json().catch(() => null);
  // An empty result comes back as [] instead of {resource: [...]}.
  return Array.isArray(body) ? [] : (body?.[resource] ?? []);
}

export async function fetchCatalog(): Promise<StoreItem[]> {
  const [products, combinations, stock, groups, values] = await Promise.all([
    get('products', '[id,reference,name,active]'),
    get('combinations', 'full'),
    get('stock_availables', '[id_product,id_product_attribute,quantity]'),
    get('product_options', '[id,name]'),
    get('product_option_values', '[id,id_attribute_group,name]'),
  ]);

  const qty = new Map<string, number>();
  for (const s of stock) qty.set(`${s.id_product}:${s.id_product_attribute}`, parseInt(s.quantity, 10) || 0);
  const groupName = new Map<string, string>(groups.map(g => [String(g.id), text(g.name)]));
  const value = new Map<string, { group: number; name: string }>(
    values.map(v => [String(v.id), { group: Number(v.id_attribute_group), name: text(v.name) }]));
  const combosOf = new Map<string, any[]>();
  for (const c of combinations) {
    const k = String(c.id_product);
    if (!combosOf.has(k)) combosOf.set(k, []);
    combosOf.get(k)!.push(c);
  }

  const items: StoreItem[] = [];
  for (const p of products) {
    if (String(p.active) !== '1') continue;
    const productId = Number(p.id);
    const productName = text(p.name);
    const combos = combosOf.get(String(p.id)) ?? [];
    if (!combos.length) {
      items.push({ productId, combinationId: 0, reference: text(p.reference), productName, options: [],
        quantity: qty.get(`${productId}:0`) ?? 0 });
      continue;
    }
    for (const c of combos) {
      const combinationId = Number(c.id);
      const options = (c.associations?.product_option_values ?? [])
        .map((o: any) => value.get(String(o.id)))
        .filter(Boolean)
        .sort((a: any, b: any) => a.group - b.group)
        .map((v: any) => ({ group: groupName.get(String(v.group)) ?? `Option ${v.group}`, value: v.name }));
      items.push({ productId, combinationId, reference: text(c.reference) || text(p.reference), productName, options,
        quantity: qty.get(`${productId}:${combinationId}`) ?? 0 });
    }
  }
  items.sort((a, b) => a.productId - b.productId || a.combinationId - b.combinationId);
  return items;
}

// ---------------------------------------------------------------------------
// Stock writes (phase 3). Only `quantity` of one stock_available row is changed (PATCH).

async function stockRow(productId: number, combinationId: number): Promise<{ id: number; quantity: number }> {
  const rows = await get('stock_availables',
    `[id,quantity]&filter[id_product]=[${productId}]&filter[id_product_attribute]=[${combinationId}]`);
  if (rows.length !== 1) throw new Error(`store: expected 1 stock row for product ${productId}/${combinationId}, found ${rows.length}`);
  return { id: Number(rows[0].id), quantity: parseInt(rows[0].quantity, 10) || 0 };
}

export async function readStock(productId: number, combinationId: number): Promise<number> {
  return (await stockRow(productId, combinationId)).quantity;
}

/** Add `delta` to an item's stock in the store; returns { before, after } as read back from the store. */
export async function addStock(productId: number, combinationId: number, delta: number): Promise<{ before: number; after: number }> {
  if (!config.store.apiKey) throw new Error('STORE_API_KEY is not set');
  const row = await stockRow(productId, combinationId);
  const want = row.quantity + delta;
  const body = `<?xml version="1.0" encoding="UTF-8"?><prestashop><stock_available><id>${row.id}</id><quantity>${want}</quantity></stock_available></prestashop>`;
  const res = await fetch(`${config.store.url}/api/stock_availables/${row.id}`, {
    method: 'PATCH', body, signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/xml', Authorization: `Basic ${Buffer.from(`${config.store.apiKey}:`).toString('base64')}` },
  });
  if (!res.ok) throw new Error(`store: stock update HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const after = await readStock(productId, combinationId);
  if (after !== want) throw new Error(`store: stock reads ${after} after setting ${want}`);
  return { before: row.quantity, after };
}

// ---------------------------------------------------------------------------
// The store's "Printed stock" module (onicprint): the inventory lives in the store now
// (2026-11-18). Parts on hand, recipes, minimums and priorities are edited there; the store
// quantity of a managed item = full sets its parts on hand allow. The controller reads it to
// plan prints and reports printed parts back.

export interface InvItem {
  productId: number; combinationId: number; reference: string; productName: string; label: string;
  options: { group: string; value: string; colour: boolean }[];
  storeColour: string | null; ignoreStoreColour: boolean; printColour: string; colour: string | null;
  managed: boolean; minQty: number; priority: number;
  recipe: { partId: number; qty: number; colour?: string; printColour?: string | null }[];   // colour: '' item, '*' any, else fixed
  storeQty: number; buildable: number | null;
}
export interface InvState {
  live: boolean; at: number; colours: string[];
  parts: { id: number; name: string; material: string; notes: string }[];
  stock: { partId: number; colour: string; qty: number }[];
  items: InvItem[];
}
export interface QtyChange { reference: string; label: string; before: number; after: number; written: boolean }

async function onicprint(method: 'GET' | 'POST', action: string, body?: unknown): Promise<any> {
  if (!config.store.apiKey) throw new Error('STORE_API_KEY is not set');
  const url = `${config.store.url}/api/onicprint?action=${action}&output_format=JSON`;
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method, signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.store.apiKey}:`).toString('base64')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e: any) {
      // Only GETs are retried blindly; "complete" is idempotent per ref, so it may be retried too.
      if (attempt >= 2) {
        const cause = e?.cause?.code || e?.cause?.message || '';
        throw new Error(`can't reach the store (Printed stock)${cause ? `: ${cause}` : `: ${e?.message || e}`}`);
      }
      await new Promise(r => setTimeout(r, attempt ? 8000 : 3000));
    }
  }
  const r: any = await res.json().catch(() => null);
  if (!res.ok || !r) throw new Error(`store Printed stock (${action}): HTTP ${res.status}`);
  if (!r.ok) throw new Error(`store Printed stock (${action}): ${r.error || 'failed'}`);
  return r;
}

export const inventoryState = (): Promise<InvState> => onicprint('GET', 'state');
export const inventoryHistory = (limit = 50): Promise<{ moves: any[]; quantities: any[] }> => onicprint('GET', `history&limit=${limit}`);
/** Printed parts arrive. Idempotent per ref (the job), so a retry never counts them twice. */
export const reportPrinted = (b: { partId: number; colour: string; qty: number; ref: string; note: string }): Promise<{ already: boolean; changes: QtyChange[] }> =>
  onicprint('POST', 'complete', b);
