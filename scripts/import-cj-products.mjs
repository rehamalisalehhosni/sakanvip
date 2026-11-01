// Fills the Supabase `products` table with CJ Dropshipping products for each storefront category.
// Safe to re-run: products are keyed by supplier_product_id and updated in place.
// Usage: DATABASE_URL=... CJ_ACCESS_TOKEN=... node scripts/import-cj-products.mjs [perCategory] [--hide-cheap]
//        DATABASE_URL=... node scripts/import-cj-products.mjs --reprice   (recalculate stored prices only)
// Pricing follows the pricing sheet: sale price = supplier price x 2.5 (MARKUP_PERCENT 150), e.g.
// 100 -> 250.00, covering shipping 16%, payment 8%, servers 6%, marketing 30%, taxes 30% and 60%
// net profit of the supplier price. At least MIN_PRICE (default 19.99) as a safety floor.
// CJ supplier prices are in USD; they are converted to EUR first with the ECB daily reference rate
// (or USD_PER_EUR if set), so $100 at 1.1172 USD/EUR -> 89.51 EUR -> 223.78 EUR sale price.
import pg from 'pg';

const REPRICE_ONLY = process.argv.includes('--reprice');
const PER_CATEGORY = Number(process.argv.find(a => /^\d+$/.test(a)) || 12);
// Only import products whose supplier price is at least this (USD), to keep quality consistent with
// the brand. With --hide-cheap, active products below it are hidden (active = false, not deleted).
const MIN_SUPPLIER_PRICE = Number(process.env.MIN_SUPPLIER_PRICE ?? 8);
const HIDE_CHEAP = process.argv.includes('--hide-cheap');
// Words in CJ product names that do not fit the storefront (CJ keyword search is broad).
const EXCLUDED = /\b(knife|knives|baby|infant|toddler|tool ?(box|set)|set-?top|fishing|garden|kitchen)\b/i;
const MAX_PAGES = 3;
// Category ids must match the `categories` ids in index.html (the page filters on them).
const SEARCHES = [
  { category: 'women', keyword: 'women dress' },
  { category: 'evening', keyword: 'evening gown' },
  { category: 'perfume', keyword: 'perfume' },
  { category: 'watches', keyword: 'luxury watch' },
  { category: 'gifts', keyword: 'jewelry gift box' },
  { category: 'accessories', keyword: 'sunglasses' },
  { category: 'bags', keyword: 'women handbag' },
  { category: 'jewelry', keyword: 'necklace' },
  { category: 'men', keyword: 'men shirt' },
  // Extra searches for categories where few CJ products reach MIN_SUPPLIER_PRICE.
  { category: 'gifts', keyword: 'watch gift set' },
  { category: 'gifts', keyword: 'perfume gift set' },
  { category: 'perfume', keyword: 'perfume women' },
  { category: 'perfume', keyword: 'perfume men' },
  { category: 'accessories', keyword: 'leather belt' },
  { category: 'accessories', keyword: 'silk scarf' },
  { category: 'accessories', keyword: 'leather wallet' }
];

const { DATABASE_URL, CJ_ACCESS_TOKEN } = process.env;
if (!DATABASE_URL || (!CJ_ACCESS_TOKEN && !REPRICE_ONLY)) {
  console.error('Set DATABASE_URL and CJ_ACCESS_TOKEN.');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstNumber = value => {
  const n = Number(String(value ?? '').trim().split('-')[0].trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};
const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT ?? 150);
const MIN_PRICE = Number(process.env.MIN_PRICE ?? 19.99);
let USD_PER_EUR = Number(process.env.USD_PER_EUR) || null;
async function loadExchangeRate() {
  if (USD_PER_EUR) return;
  const xml = await (await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml')).text();
  const rate = Number(/currency='USD' rate='([\d.]+)'/.exec(xml)?.[1]);
  if (!(rate > 0)) throw new Error('Could not read the ECB USD rate; set USD_PER_EUR.');
  USD_PER_EUR = rate;
}
// Supplier price (USD) -> EUR -> x2.5, in whole cents so x.xx5 rounds up exactly.
const retailPrice = supplierPriceUsd => {
  const eurCents = Math.round(supplierPriceUsd * 100 / USD_PER_EUR);
  return Math.max(Math.round(eurCents * (100 + MARKUP_PERCENT) / 100) / 100, MIN_PRICE);
};

async function productDetail(pid) {
  const url = new URL('https://developers.cjdropshipping.com/api2.0/v1/product/query');
  url.searchParams.set('pid', pid);
  const response = await fetch(url, { headers: { 'CJ-Access-Token': CJ_ACCESS_TOKEN } });
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ product ${pid}: ${body.message || response.status}`);
  return body.data;
}

async function search(keyword, page = 1) {
  const url = new URL('https://developers.cjdropshipping.com/api2.0/v1/product/listV2');
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', '100');
  url.searchParams.set('keyWord', keyword);
  const response = await fetch(url, { headers: { 'CJ-Access-Token': CJ_ACCESS_TOKEN } });
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ "${keyword}": ${body.message || response.status}`);
  return (body.data?.content || []).flatMap(c => c.productList || []);
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await loadExchangeRate();
console.log(`Exchange rate: 1 EUR = ${USD_PER_EUR} USD`);
await client.query('ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_product_id text UNIQUE');
await client.query('ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_price numeric(12,2)');
const runStarted = new Date();

if (REPRICE_ONLY) {
  const { rows } = await client.query('SELECT id, supplier_price, price FROM public.products WHERE supplier_price IS NOT NULL');
  let changed = 0;
  for (const row of rows) {
    const price = retailPrice(Number(row.supplier_price));
    if (price === Number(row.price)) continue;
    await client.query('UPDATE public.products SET price = $1, updated_at = now() WHERE id = $2', [price, row.id]);
    changed++;
  }
  await client.end();
  console.log(`Repriced ${changed} of ${rows.length} products (markup ${MARKUP_PERCENT}%, minimum ${MIN_PRICE}).`);
  process.exit(0);
}

let total = 0;
const perCategory = {};
for (const [index, { category, keyword }] of SEARCHES.entries()) {
  const wanted = PER_CATEGORY - (perCategory[category] || 0);
  if (wanted <= 0) continue;
  if (index > 0) await sleep(1200); // CJ allows ~1 request per second
  const picked = [];
  for (let page = 1; page <= MAX_PAGES && picked.length < wanted; page++) {
    if (page > 1) await sleep(1200);
    const items = (await search(keyword, page))
      .map(p => ({ id: String(p.id || ''), name: String(p.nameEn || '').replace(/\s+/g, ' ').trim(), price: firstNumber(p.sellPrice), image: p.bigImage }))
      .filter(p => p.id && p.name && /^[\x20-\x7E -ɏ]+$/.test(p.name) && p.price >= MIN_SUPPLIER_PRICE && !EXCLUDED.test(p.name) && /^https:\/\//.test(p.image || ''));
    for (const p of items) if (picked.length < wanted && !picked.some(x => x.id === p.id)) picked.push(p);
    if (!items.length && page > 1) break;
  }
  for (const p of picked) {
    await client.query(
      `INSERT INTO public.products (name, category, description, price, image_url, active, supplier_product_id, supplier_price)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       ON CONFLICT (supplier_product_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
         price = EXCLUDED.price, supplier_price = EXCLUDED.supplier_price, image_url = EXCLUDED.image_url, active = true, updated_at = now()`,
      [p.name.slice(0, 200), category, `SAKANVIP · ${p.name}`.slice(0, 500), retailPrice(p.price), p.image, `cj-${p.id}`, p.price]
    );
  }
  total += picked.length;
  perCategory[category] = (perCategory[category] || 0) + picked.length;
  console.log(`${category}: ${picked.length} products ("${keyword}")`);
}

let hidden = 0;
if (HIDE_CHEAP) {
  const result = await client.query(
    'UPDATE public.products SET active = false, updated_at = now() WHERE active AND supplier_price < $1',
    [MIN_SUPPLIER_PRICE]
  );
  hidden = result.rowCount;
  const { rows: active } = await client.query('SELECT id, name FROM public.products WHERE active');
  for (const row of active.filter(r => EXCLUDED.test(r.name || ''))) {
    await client.query('UPDATE public.products SET active = false, updated_at = now() WHERE id = $1', [row.id]);
    hidden++;
  }
  console.log(`Hidden ${hidden} active products (supplier price below ${MIN_SUPPLIER_PRICE} or excluded words).`);
}

// Active products imported earlier that this run's searches did not return: re-read their supplier
// price from CJ so every product follows the same pricing rule.
const { rows: stale } = await client.query(
  'SELECT id, supplier_product_id FROM public.products WHERE active AND supplier_product_id LIKE $1 AND updated_at < $2',
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
console.log(`Done: ${total} products imported or updated, ${repriced} of ${stale.length} older products repriced (markup ${MARKUP_PERCENT}%, minimum ${MIN_PRICE}).`);
