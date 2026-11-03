// Fills the Supabase `products` table with CJ Dropshipping products for each storefront category.
// Safe to re-run: products are keyed by supplier_product_id and updated in place.
// Usage: DATABASE_URL=... CJ_ACCESS_TOKEN=... node scripts/import-cj-products.mjs [perCategory] [--hide-cheap]
//        DATABASE_URL=... [CJ_ACCESS_TOKEN=...] node scripts/import-cj-products.mjs --reprice [--refresh-shipping]
//          (recalculate stored prices; with a CJ token, also look up missing shipping costs,
//           or all of them with --refresh-shipping)
//        DATABASE_URL=... CJ_ACCESS_TOKEN=... node scripts/import-cj-products.mjs --variants [--only=<category>]
//          (load each active product's CJ variants into product_variants)
// Pricing follows the pricing sheet: sale price = supplier price x 2.5 (MARKUP_PERCENT 150), e.g.
// 100 -> 250.00, covering payment 8%, servers 6%, marketing 30%, taxes 30% and 60% net profit of the
// supplier price. CJ's cheapest shipping to Germany (SHIP_TO) is added on top, since the shop ships
// for free and real shipping (4-18 EUR) is more than the sheet's 16%. At least MIN_PRICE (default 19.99).
// Prices end in 9.99 (psychological pricing, nearest). CJ prices are in USD; they are converted to EUR with the ECB daily reference rate
// (or USD_PER_EUR if set), so $100 at 1.1172 USD/EUR -> 89.51 EUR -> 223.78 -> 219.99 EUR sale price.
import pg from 'pg';

const REPRICE_ONLY = process.argv.includes('--reprice');
const PER_CATEGORY = Number(process.argv.find(a => /^\d+$/.test(a)) || 12);
// Only import products whose supplier price is at least this (USD), to keep quality consistent with
// the brand. With --hide-cheap, active products below it are hidden (active = false, not deleted).
const MIN_SUPPLIER_PRICE = Number(process.env.MIN_SUPPLIER_PRICE ?? 8);
const HIDE_CHEAP = process.argv.includes('--hide-cheap');
const REFRESH_SHIPPING = process.argv.includes('--refresh-shipping');
const VARIANTS_ONLY = process.argv.includes('--variants');
// --only=<category id>: import just that category (e.g. --only=scarves after adding a category to index.html).
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const SHIP_TO = process.env.SHIP_TO || 'DE';
// Words in CJ product names that do not fit the storefront (CJ keyword search is broad).
const EXCLUDED = /\b(knife|knives|baby|infant|toddler|kids?|child(ren)?'?s?|girls'?|pet|puppy|costume|halloween|cos|tool ?(box|set)|set-?top|fishing|garden|kitchen|car|climbing|lanyard|beads|machine|headset|workout|usb|heat(ed|ing)|mask)\b/i;
// Categories whose products must name what they are (CJ keyword search also returns unrelated items).
const CATEGORY_WORDS = {
  scarves: /^(?!.*\b(coat|jacket|sweater|suit|necklace)\b).*\b(scarf|scarves|shawl|stole)\b/i,
  watches: /watch/i,
  jewelry: /necklace|pendant|earring|bracelet|ring|jewel/i
};
const fitsStore = (name, category) => !EXCLUDED.test(name) && (!CATEGORY_WORDS[category] || CATEGORY_WORDS[category].test(name));
const MAX_PAGES = 3;
// Category ids must match the `categories` ids in index.html (the page filters on them).
const SEARCHES = [
  { category: 'women', keyword: 'women dress' },
  { category: 'evening', keyword: 'evening gown' },
  { category: 'scarves', keyword: 'silk scarf' },
  { category: 'watches', keyword: 'luxury watch' },
  { category: 'gifts', keyword: 'jewelry gift box' },
  { category: 'accessories', keyword: 'leather belt' },
  { category: 'bags', keyword: 'women handbag' },
  { category: 'jewelry', keyword: 'necklace' },
  { category: 'men', keyword: 'men shirt' },
  // Extra searches for categories where few CJ products reach MIN_SUPPLIER_PRICE.
  { category: 'gifts', keyword: 'watch gift set' },
  { category: 'gifts', keyword: 'silk scarf gift box' },
  { category: 'scarves', keyword: 'cashmere scarf' },
  { category: 'scarves', keyword: 'shawl' },
  { category: 'accessories', keyword: 'leather wallet' },
  { category: 'accessories', keyword: 'leather card holder' }
];

const { DATABASE_URL, CJ_ACCESS_TOKEN } = process.env;
if (!DATABASE_URL || (!CJ_ACCESS_TOKEN && (!REPRICE_ONLY || REFRESH_SHIPPING || VARIANTS_ONLY))) {
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
// Supplier price (USD) -> EUR -> x2.5, plus shipping (USD -> EUR), in whole cents so x.xx5 rounds up exactly.
// Psychological pricing: move the sheet price to the nearest price ending in 9.99 (51.53 -> 49.99,
// 57.10 -> 59.99), at most 5 EUR either way, so profit stays close to supplier x 2.5 on average.
// PRICE_ENDING=none keeps the exact sheet price.
const CHARM_PRICING = process.env.PRICE_ENDING !== 'none';
const retailPrice = (supplierPriceUsd, shippingUsd = 0) => {
  const eurCents = Math.round(supplierPriceUsd * 100 / USD_PER_EUR);
  let cents = Math.round(eurCents * (100 + MARKUP_PERCENT) / 100) + Math.round(shippingUsd * 100 / USD_PER_EUR);
  if (CHARM_PRICING) {
    const below = Math.floor((cents + 1) / 1000) * 1000 - 1; // highest x9.99 at or below
    cents = cents - below <= below + 1000 - cents ? below : below + 1000;
  }
  return Math.max(cents / 100, MIN_PRICE);
};

async function productDetail(pid) {
  const url = new URL('https://developers.cjdropshipping.com/api2.0/v1/product/query');
  url.searchParams.set('pid', pid);
  const response = await fetch(url, { headers: { 'CJ-Access-Token': CJ_ACCESS_TOKEN } });
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ product ${pid}: ${body.message || response.status}`);
  return body.data;
}

// Cheapest CJ shipping (USD) from China to SHIP_TO for one unit of the product's first variant.
async function shippingCost(pid, detail = null) {
  if (!detail) { await sleep(1200); detail = await productDetail(pid); }
  const vid = detail?.variants?.[0]?.vid;
  if (!vid) return null;
  await sleep(1200);
  const response = await fetch('https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate', {
    method: 'POST',
    headers: { 'CJ-Access-Token': CJ_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startCountryCode: 'CN', endCountryCode: SHIP_TO, products: [{ quantity: 1, vid }] })
  });
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ freight ${pid}: ${body.message || response.status}`);
  const prices = (body.data || []).map(q => Number(q.logisticPrice)).filter(p => p > 0);
  return prices.length ? Math.min(...prices) : null;
}

// CJ names a product's dimensions in productKeyEn ("Color-Size") and each variant's values in variantKey
// ("Sky blue-M"). Values can contain "-" ("Off-white-M"), so extra parts belong to the first dimension.
function variantOptions(dims, key) {
  const parts = String(key || '').split('-');
  if (dims.length <= 1 || parts.length < dims.length) return { [dims[0] || 'Style']: String(key || '').trim() };
  const tail = parts.splice(parts.length - (dims.length - 1));
  return Object.fromEntries(dims.map((d, i) => [d, (i === 0 ? parts.join('-') : tail[i - 1]).trim()]));
}

// Stores the product's CJ variants with their own sale price, hides variants CJ no longer lists and sets
// the product's price to its cheapest variant. Returns the number of active variants.
async function syncVariants(productId, detail, shippingUsd) {
  const dims = String(detail?.productKeyEn || '').split('-').map(d => d.trim()).filter(Boolean);
  const seen = [];
  for (const v of detail?.variants || []) {
    const supplier = firstNumber(v.variantSellPrice);
    if (!v.vid || !supplier) continue;
    const options = variantOptions(dims, v.variantKey);
    const size = Object.entries(options).find(([k]) => /size/i.test(k))?.[1] || null;
    const color = Object.entries(options).filter(([k]) => !/size/i.test(k)).map(([, x]) => x).join(' / ') || null;
    await client.query(
      `INSERT INTO public.product_variants (product_id, cj_vid, sku, options, size, color, supplier_price, price, image_url, weight_g, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       ON CONFLICT (cj_vid) DO UPDATE SET product_id = EXCLUDED.product_id, sku = EXCLUDED.sku, options = EXCLUDED.options,
         size = EXCLUDED.size, color = EXCLUDED.color, supplier_price = EXCLUDED.supplier_price, price = EXCLUDED.price,
         image_url = EXCLUDED.image_url, weight_g = EXCLUDED.weight_g, active = true, updated_at = now()`,
      [productId, String(v.vid), v.variantSku || null, options, size, color, supplier, retailPrice(supplier, shippingUsd || 0),
       /^https:\/\//.test(v.variantImage || '') ? v.variantImage : null, Math.round(Number(v.variantWeight)) || null]
    );
    seen.push(String(v.vid));
  }
  await client.query('UPDATE public.product_variants SET active = false, updated_at = now() WHERE product_id = $1 AND NOT (cj_vid = ANY($2))', [productId, seen]);
  await client.query(
    `UPDATE public.products SET variant_dims = $2, updated_at = now(),
       price = COALESCE((SELECT min(price) FROM public.product_variants WHERE product_id = $1 AND active), price) WHERE id = $1`,
    [productId, dims.length ? dims : null]
  );
  return seen.length;
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
await client.query('ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_shipping numeric(12,2)');
const runStarted = new Date();

if (REPRICE_ONLY) {
  const { rows } = await client.query('SELECT id, active, supplier_product_id, supplier_price, supplier_shipping, price FROM public.products WHERE supplier_price IS NOT NULL');
  let changed = 0, shipped = 0;
  for (const row of rows) {
    if (CJ_ACCESS_TOKEN && row.active && row.supplier_product_id?.startsWith('cj-') && (REFRESH_SHIPPING || row.supplier_shipping == null)) {
      try {
        const cost = await shippingCost(row.supplier_product_id.slice(3));
        if (cost != null) {
          row.supplier_shipping = cost;
          await client.query('UPDATE public.products SET supplier_shipping = $1 WHERE id = $2', [cost, row.id]);
          shipped++;
        } else {
          // No CJ shipping route to SHIP_TO (e.g. perfume as a liquid): it could be sold but never delivered.
          await client.query('UPDATE public.products SET active = false, updated_at = now() WHERE id = $1', [row.id]);
          console.log(`Hidden ${row.supplier_product_id}: CJ cannot ship it to ${SHIP_TO}.`);
        }
      } catch (err) {
        console.warn(`Could not get shipping for ${row.supplier_product_id}: ${err.message}`);
      }
    }
    const price = retailPrice(Number(row.supplier_price), Number(row.supplier_shipping || 0));
    if (price === Number(row.price)) continue;
    await client.query('UPDATE public.products SET price = $1, updated_at = now() WHERE id = $2', [price, row.id]);
    changed++;
  }
  const { rows: variants } = await client.query(
    'SELECT v.id, v.supplier_price, v.price, p.supplier_shipping FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE v.active AND v.supplier_price IS NOT NULL');
  for (const v of variants) {
    const price = retailPrice(Number(v.supplier_price), Number(v.supplier_shipping || 0));
    if (price !== Number(v.price)) await client.query('UPDATE public.product_variants SET price = $1, updated_at = now() WHERE id = $2', [price, v.id]);
  }
  await client.query(`UPDATE public.products p SET price = m.price FROM
    (SELECT product_id, min(price) price FROM public.product_variants WHERE active GROUP BY product_id) m WHERE m.product_id = p.id AND p.price <> m.price`);
  await client.end();
  console.log(`Repriced ${changed} of ${rows.length} products and ${variants.length} variants (markup ${MARKUP_PERCENT}%, minimum ${MIN_PRICE}); shipping looked up for ${shipped}.`);
  process.exit(0);
}

if (VARIANTS_ONLY) {
  const { rows } = await client.query(
    "SELECT id, supplier_product_id, supplier_shipping FROM public.products WHERE active AND supplier_product_id LIKE 'cj-%' AND ($1::text IS NULL OR category = $1)",
    [ONLY ?? null]);
  let synced = 0, count = 0;
  for (const row of rows) {
    await sleep(1200);
    try {
      const n = await syncVariants(row.id, await productDetail(row.supplier_product_id.slice(3)), Number(row.supplier_shipping || 0));
      if (n) { synced++; count += n; } else console.warn(`No orderable CJ variants for ${row.supplier_product_id}`);
    } catch (err) {
      console.warn(`Could not load variants for ${row.supplier_product_id}: ${err.message}`);
    }
  }
  await client.end();
  console.log(`Variants: ${count} for ${synced} of ${rows.length} products.`);
  process.exit(0);
}

let total = 0;
const perCategory = {};
for (const [index, { category, keyword }] of SEARCHES.filter(s => !ONLY || s.category === ONLY).entries()) {
  const wanted = PER_CATEGORY - (perCategory[category] || 0);
  if (wanted <= 0) continue;
  if (index > 0) await sleep(1200); // CJ allows ~1 request per second
  const picked = [];
  for (let page = 1; page <= MAX_PAGES && picked.length < wanted; page++) {
    if (page > 1) await sleep(1200);
    const items = (await search(keyword, page))
      .map(p => ({ id: String(p.id || ''), name: String(p.nameEn || '').replace(/\s+/g, ' ').trim(), price: firstNumber(p.sellPrice), image: p.bigImage }))
      .filter(p => p.id && p.name && /^[\x20-\x7E -ɏ]+$/.test(p.name) && p.price >= MIN_SUPPLIER_PRICE && fitsStore(p.name, category) && /^https:\/\//.test(p.image || ''));
    for (const p of items) if (picked.length < wanted && !picked.some(x => x.id === p.id)) picked.push(p);
    if (!items.length && page > 1) break;
  }
  for (const p of picked) {
    let shipping = null, detail = null;
    try { await sleep(1200); detail = await productDetail(p.id); shipping = await shippingCost(p.id, detail); } catch (err) { console.warn(err.message); }
    if (shipping == null) continue; // not shippable to SHIP_TO
    const { rows: [saved] } = await client.query(
      `INSERT INTO public.products (name, category, description, price, image_url, active, supplier_product_id, supplier_price, supplier_shipping)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
       ON CONFLICT (supplier_product_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
         price = EXCLUDED.price, supplier_price = EXCLUDED.supplier_price, supplier_shipping = EXCLUDED.supplier_shipping,
         image_url = EXCLUDED.image_url, active = true, updated_at = now()
       RETURNING id`,
      [p.name.slice(0, 200), category, `SAKANVIP · ${p.name}`.slice(0, 500), retailPrice(p.price, shipping), p.image, `cj-${p.id}`, p.price, shipping]
    );
    await syncVariants(saved.id, detail, shipping);
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
  const { rows: active } = await client.query('SELECT id, name, category FROM public.products WHERE active');
  for (const row of active.filter(r => !fitsStore(r.name || '', r.category))) {
    await client.query('UPDATE public.products SET active = false, updated_at = now() WHERE id = $1', [row.id]);
    hidden++;
  }
  console.log(`Hidden ${hidden} active products (supplier price below ${MIN_SUPPLIER_PRICE}, excluded words or wrong category).`);
}

// Active products imported earlier that this run's searches did not return: re-read their supplier
// price from CJ so every product follows the same pricing rule.
const { rows: stale } = await client.query(
  'SELECT id, supplier_product_id, supplier_shipping FROM public.products WHERE active AND supplier_product_id LIKE $1 AND updated_at < $2 AND ($3::text IS NULL OR category = $3)',
  ['cj-%', runStarted, ONLY ?? null]
);
let repriced = 0;
for (const row of stale) {
  await sleep(1200);
  try {
    const supplierPrice = firstNumber((await productDetail(row.supplier_product_id.slice(3)))?.sellPrice);
    if (!supplierPrice) continue;
    const shipping = row.supplier_shipping == null ? await shippingCost(row.supplier_product_id.slice(3)) : Number(row.supplier_shipping);
    await client.query('UPDATE public.products SET price = $1, supplier_price = $2, supplier_shipping = $3, updated_at = now() WHERE id = $4',
      [retailPrice(supplierPrice, shipping || 0), supplierPrice, shipping, row.id]);
    repriced++;
  } catch (err) {
    console.warn(`Could not reprice ${row.supplier_product_id}: ${err.message}`);
  }
}
await client.end();
console.log(`Done: ${total} products imported or updated, ${repriced} of ${stale.length} older products repriced (markup ${MARKUP_PERCENT}%, minimum ${MIN_PRICE}).`);
