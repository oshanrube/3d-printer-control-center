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
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${config.store.apiKey}:`).toString('base64')}` },
    signal: AbortSignal.timeout(60_000),
  });
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
