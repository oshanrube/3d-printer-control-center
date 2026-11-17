import { config } from './config.js';

/**
 * Read-only client for the PrestaShop webservice (https://store.onicindustries.com/api).
 * The controller uses this to keep the store's stock levels topped up.
 */

export interface StoreOption {
  group: string;
  value: string;
}

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

interface ProductRow {
  id: number;
  id_default_combination: number;
  type: string;
  reference: string;
  active: string;
  name: string | { id: number; value: string }[];
}

interface CombinationRow {
  id: number;
  id_product: string | number;
  reference: string;
  associations: {
    product_option_values: Array<{ id: string | number }>;
  };
}

interface StockRow {
  id: number;
  id_product: string | number;
  id_product_attribute: string | number;
  quantity: string;
}

interface OptionRow {
  id: number;
  name: string;
}

interface OptionValueRow {
  id: number;
  id_attribute_group: number;
  name: string;
}

interface FetchResult {
  products: ProductRow[];
  combinations: CombinationRow[];
  stock_availables: StockRow[];
  product_options: OptionRow[];
  product_option_values: OptionValueRow[];
}

async function get(resource: string, display: string): Promise<string> {
  const url = `${config.store.url}/api/${resource}?output_format=JSON&display=${display}&limit=1000`;

  if (!config.store.apiKey) {
    throw new Error('STORE_API_KEY is required to fetch store data');
  }

  const auth = Buffer.from(`${config.store.apiKey}:`).toString('base64');

  const controller = new AbortController();
  const timeout = 60_000;
  const signal = AbortSignal.timeout(timeout);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'output_format': 'JSON',
      },
      signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${resource}: HTTP ${res.status}`);
    }

    return res.body?.getReader().read().then(r => r?.value.toString()).join('');
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request to ${resource} timed out after 60s`);
    }
    throw err;
  }
}

export async function fetchCatalog(): Promise<StoreItem[]> {
  const [productsJson, combinationsJson, stockJson, optionsJson, valuesJson] = await Promise.all([
    get('product', 'display=[id,reference,name,active]'),
    get('product_attribute', 'display=full'),
    get('stock_available', 'display=[id_product,id_product_attribute,quantity]'),
    get('product_attribute_group', 'display=[id,name]'),
    get('product_attribute_value', 'display=[id,id_attribute_group,name]'),
  ]);

  const products: ProductRow[] = JSON.parse(productsJson);
  const combinations: CombinationRow[] = JSON.parse(combinationsJson);
  const stock: StockRow[] = JSON.parse(stockJson);
  const options: OptionRow[] = JSON.parse(optionsJson);
  const values: OptionValueRow[] = JSON.parse(valuesJson);

  // Build lookup maps
  const combMap = new Map<string | number, CombinationRow>();
  combinations.forEach(c => combMap.set(String(c.id), c));

  const stockMap = new Map<string | number, Map<string | number, StockRow>>();
  stock.forEach(s => {
    const key = `${String(s.id_product)}:${String(s.id_product_attribute)}`;
    if (!stockMap.has(key)) {
      stockMap.set(key, new Map());
    }
    stockMap.get(key)!.set(String(s.id_product_attribute), s);
  });

  const optionMap = new Map<number, OptionRow>();
  options.forEach(o => optionMap.set(o.id, o));

  const valuesMap = new Map<string, OptionValueRow>();
  values.forEach(v => valuesMap.set(String(v.id), v));

  const items: StoreItem[] = [];

  for (const p of products) {
    // Only include active products
    if (p.active !== '1' && p.active !== '1') continue;

    const productId = Number(p.id);
    const combinationId = p.id_default_combination;

    // If no combinations or the default combination is 0, treat as no combinations
    const hasCombinations = p.id_default_combination > 0 && combMap.has(String(p.id_default_combination));

    if (!hasCombinations) {
      // Product without combinations
      const productName = Array.isArray(p.name)
        ? p.name[0]?.value ?? ''
        : String(p.name);

      items.push({
        productId,
        combinationId: 0,
        reference: p.reference,
        productName,
        options: [],
        quantity: 0,
      });
    } else {
      // Product with combinations
      const comb = combMap.get(String(p.id_default_combination));
      if (!comb) continue;

      // Get all combinations for this product
      const productCombs = combinations.filter(c => String(c.id_product) === String(p.id));

      for (const c of productCombs) {
        const productName = Array.isArray(p.name)
          ? p.name[0]?.value ?? ''
          : String(p.name);

        // Build options from the combination's associations
        const optionIds = new Map<number, number>(); // group_id -> value_id
        c.associations.product_option_values.forEach(v => {
          const vid = Number(v.id);
          const val = valuesMap.get(String(vid));
          if (val) {
            optionIds.set(val.id_attribute_group, vid);
          }
        });

        // Sort options by group id
        const sortedGroups = Array.from(optionIds.keys()).sort((a, b) => a - b);
        const options: StoreOption[] = sortedGroups.map(groupId => ({
          group: optionMap.get(groupId)?.name ?? `Group ${groupId}`,
          value: valuesMap.get(String(optionIds.get(groupId)!))?.name ?? '',
        }));

        const combinationId = Number(c.id);
        const reference = c.reference;

        // Get stock quantity
        const stockKey = `${String(p.id)}:${String(combinationId)}`;
        const stockEntry = stockMap.get(stockKey);
        const quantityStr = stockEntry?.get(String(combinationId))?.quantity ?? '0';
        const quantity = parseInt(quantityStr, 10) || 0;

        items.push({
          productId,
          combinationId,
          reference,
          productName,
          options,
          quantity,
        });
      }
    }
  }

  // Sort by productId, then combinationId
  items.sort((a, b) => {
    if (a.productId !== b.productId) return a.productId - b.productId;
    return a.combinationId - b.combinationId;
  });

  return items;
}
