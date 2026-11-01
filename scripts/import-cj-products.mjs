// Fills the Supabase `products` table with CJ Dropshipping products for each storefront category.
// Safe to re-run: products are keyed by supplier_product_id and updated in place.
// Usage: DATABASE_URL=... CJ_ACCESS_TOKEN=... node scripts/import-cj-products.mjs [perCategory]
// Pricing: sale price = supplier price + MARKUP_PERCENT (default 150%, i.e. supplier price x 2.5),
// rounded to a .99 ending that never falls below that minimum.
import pg from 'pg';

const PER_CATEGORY = Number(process.argv[2] || 12);
// Category ids must match the `categories` ids in index.html (the page filters on them).
const SEARCHES = [
  { category: 'women', keyword: 'women dress' },
  { category: 'evening', keyword: 'evening gown' },
  { category: 'perfume', keyword: 'perfume' },
  { category: 'watches', keyword: 'luxury watch' },
  { category: 'gifts', keyword: 'gift box set' },
  { category: 'accessories', keyword: 'sunglasses' },
  { category: 'bags', keyword: 'women handbag' },
  { category: 'jewelry', keyword: 'necklace' },
  { category: 'men', keyword: 'men shirt' }
];

const { DATABASE_URL, CJ_ACCESS_TOKEN } = process.env;
if (!DATABASE_URL || !CJ_ACCESS_TOKEN) {
  console.error('Set DATABASE_URL and CJ_ACCESS_TOKEN.');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstNumber = value => {
  const n = Number(String(value ?? '').trim().split('-')[0].trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};
const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT ?? 150);
const retailPrice = supplierPrice => {
  const minimum = supplierPrice * (1 + MARKUP_PERCENT / 100);
  let price = Math.floor(minimum) + 0.99;
  if (price < minimum) price += 1;
  return Number(price.toFixed(2));
};

async function productDetail(pid) {
  const url = new URL('https://developers.cjdropshipping.com/api2.0/v1/product/query');
  url.searchParams.set('pid', pid);
  const response = await fetch(url, { headers: { 'CJ-Access-Token': CJ_ACCESS_TOKEN } });
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ product ${pid}: ${body.message || response.status}`);
  return body.data;
}

async function search(keyword) {
  const url = new URL('https://developers.cjdropshipping.com/api2.0/v1/product/listV2');
  url.searchParams.set('page', '1');
  url.searchParams.set('size', '50');
  url.searchParams.set('keyWord', keyword);
  const response = await fetch(url, { headers: { 'CJ-Access-Token': CJ_ACCESS_TOKEN } });
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ "${keyword}": ${body.message || response.status}`);
  return (body.data?.content || []).flatMap(c => c.productList || []);
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_product_id text UNIQUE');
await client.query('ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_price numeric(12,2)');
const runStarted = new Date();

let total = 0;
for (const [index, { category, keyword }] of SEARCHES.entries()) {
  if (index > 0) await sleep(1200); // CJ allows ~1 request per second
  const picked = (await search(keyword))
    .map(p => ({ id: String(p.id || ''), name: String(p.nameEn || '').replace(/\s+/g, ' ').trim(), price: firstNumber(p.sellPrice), image: p.bigImage }))
    .filter(p => p.id && p.name && /^[\x20-\x7E -ɏ]+$/.test(p.name) && p.price && /^https:\/\//.test(p.image || ''))
    .slice(0, PER_CATEGORY);
  for (const p of picked) {
    await client.query(
      `INSERT INTO public.products (name, category, description, price, image_url, active, supplier_product_id, supplier_price)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       ON CONFLICT (supplier_product_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
         price = EXCLUDED.price, supplier_price = EXCLUDED.supplier_price, image_url = EXCLUDED.image_url, updated_at = now()`,
      [p.name.slice(0, 200), category, `SAKANVIP · ${p.name}`.slice(0, 500), retailPrice(p.price), p.image, `cj-${p.id}`, p.price]
    );
  }
  total += picked.length;
  console.log(`${category}: ${picked.length} products ("${keyword}")`);
}

// Products imported earlier that this run's searches did not return: re-read their supplier price
// from CJ so every product follows the same pricing rule.
const { rows: stale } = await client.query(
  'SELECT id, supplier_product_id FROM public.products WHERE supplier_product_id LIKE $1 AND updated_at < $2',
  ['cj-%', runStarted]
);
let repriced = 0;
for (const row of stale) {
  await sleep(1200);
  try {
    const supplierPrice = firstNumber((await productDetail(row.supplier_product_id.slice(3)))?.sellPrice);
    if (!supplierPrice) continue;
    await client.query('UPDATE public.products SET price = $1, supplier_price = $2, updated_at = now() WHERE id = $3',
      [retailPrice(supplierPrice), supplierPrice, row.id]);
    repriced++;
  } catch (err) {
    console.warn(`Could not reprice ${row.supplier_product_id}: ${err.message}`);
  }
}
await client.end();
console.log(`Done: ${total} products imported or updated, ${repriced} of ${stale.length} older products repriced (markup ${MARKUP_PERCENT}%).`);
