// SakanVIP on Cloudflare Workers: serves the static storefront (assets) and the API routes
// the storefront calls. Ported from server/server.js (Express); accounts and carts live in
// Supabase (auth + cart_items), so the old SQLite register/verify/subscribe routes are not needed.
import Stripe from 'stripe';
import { WorkerMailer } from 'worker-mailer';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { recordPaidOrder, variantText } from './orders.js';
import { sendToCj, retryCjOrders, checkCjTracking } from './cj.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EU_COUNTRIES = ['DE', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'SE'];
const CJ_READ_TOOLS = ['search_products', 'query_sku_details', 'get_warehouses', 'calculate_freight'];
// Size / colour as chosen on the page; "|" is reserved as the PayPal SKU separator.
const VARIANT = /^[\p{L}\p{N} .,'()+-]{1,40}$/u;
const emailOk = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

class UserError extends Error {}

// "SakanVIP <info@example.com>" -> { name, email }
function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  return match ? { name: match[1].replace(/^"|"$/g, ''), email: match[2] } : { email: String(value || '').trim() };
}

function validateShipping(input) {
  const name = String(input?.name || '').trim().slice(0, 120);
  const street = String(input?.street || '').trim().slice(0, 200);
  const city = String(input?.city || '').trim().slice(0, 120);
  const postalCode = String(input?.postalCode || '').trim().slice(0, 24);
  const country = String(input?.country || 'DE').trim().toUpperCase();
  // CJ and the carriers need a phone number for delivery; spaces, brackets, dots and dashes are dropped.
  const phone = String(input?.phone || '').replace(/[\s()./-]/g, '');
  if (!street || !city || !postalCode || !EU_COUNTRIES.includes(country)) throw new UserError('Versandadresse ungültig.');
  if (!/^\+?\d{6,15}$/.test(phone)) throw new UserError('Bitte geben Sie eine gültige Telefonnummer für die Zustellung an.');
  return { name, street, city, postalCode, country, phone };
}

// Constant-time comparison of two strings.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y) && a.length === b.length;
}

async function withCjClient(env, fn) {
  if (!env.CJ_MCP_TOKEN) throw new Error('CJ_MCP_TOKEN is not configured');
  const client = new McpClient({ name: 'sakanvip-backend', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://developers.cjdropshipping.com/mcp/' + encodeURIComponent(env.CJ_MCP_TOKEN)));
  try { await client.connect(transport); return await fn(client); }
  finally { try { await transport.close(); } catch {} }
}

async function trustedCart(env, items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new UserError('Warenkorb ungültig.');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error('Produktdatenbank ist nicht konfiguriert.');
  const variant = value => (value == null || value === '' ? '' : String(value).trim());
  const normalized = items.map(x => ({
    id: String(x?.product_id || ''), variantId: String(x?.variant_id || ''), quantity: Number(x?.quantity), size: variant(x?.size), color: variant(x?.color)
  }));
  if (normalized.some(x => !UUID.test(x.id) || (x.variantId && !UUID.test(x.variantId)) || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 20 ||
    [x.size, x.color].some(v => v && !VARIANT.test(v)))) {
    throw new UserError('Warenkorbposition ungültig.');
  }
  const ids = [...new Set(normalized.map(x => x.id))];
  const url = new URL('/rest/v1/products', env.SUPABASE_URL);
  url.searchParams.set('select', 'id,name,price,active');
  url.searchParams.set('id', `in.(${ids.join(',')})`);
  url.searchParams.set('active', 'eq.true');
  const response = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } });
  if (!response.ok) throw new Error('Produktdaten konnten nicht geladen werden.');
  const byId = new Map((await response.json()).map(p => [p.id, p]));
  if (ids.some(id => !byId.has(id))) throw new UserError('Ein Produkt ist nicht verfügbar.');
  // A product with CJ variants is sold per variant: price, size and colour come from the variant row.
  const variantsUrl = new URL('/rest/v1/product_variants', env.SUPABASE_URL);
  variantsUrl.searchParams.set('select', 'id,product_id,price,size,color');
  variantsUrl.searchParams.set('product_id', `in.(${ids.join(',')})`);
  variantsUrl.searchParams.set('active', 'eq.true');
  const variantsResponse = await fetch(variantsUrl, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } });
  if (!variantsResponse.ok) throw new Error('Produktvarianten konnten nicht geladen werden.');
  const variants = await variantsResponse.json();
  return normalized.map(x => {
    const product = byId.get(x.id);
    const own = variants.filter(v => v.product_id === x.id);
    if (!own.length) return { product, quantity: x.quantity, size: x.size, color: x.color, variantId: '' };
    const chosen = own.find(v => v.id === x.variantId);
    if (!chosen) throw new UserError(`Bitte wählen Sie Größe und Farbe für "${String(product.name).slice(0, 60)}" erneut aus.`);
    return { product: { ...product, price: chosen.price }, quantity: x.quantity, size: chosen.size || '', color: chosen.color || '', variantId: chosen.id };
  });
}

const paypalBase = env => (env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const paypalReady = env => Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

async function paypalAccessToken(env) {
  const r = await fetch(paypalBase(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error('PayPal Auth fehlgeschlagen.');
  return data.access_token;
}

function smtpReady(env) {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM);
}

async function sendMail(env, message) {
  const port = Number(env.SMTP_PORT);
  if (![465, 587].includes(port)) throw new Error('SMTP_PORT must be 465 (TLS) or 587 (STARTTLS)');
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST, port, secure: port === 465, startTls: port === 587,
      credentials: { username: env.SMTP_USER, password: env.SMTP_PASS }, authType: ['plain', 'login']
    },
    { from: parseAddress(env.MAIL_FROM), ...message }
  );
}

async function contact(env, body) {
  if (!smtpReady(env)) return json({ error: 'E-Mail-Versand ist noch nicht konfiguriert.' }, 503);
  const email = String(body?.email || '').trim();
  const subject = String(body?.subject || 'SakanVIP Kontaktanfrage').slice(0, 160);
  const message = String(body?.message || '').trim();
  if (!emailOk(email) || message.length < 5 || message.length > 5000) return json({ error: 'Bitte prüfen Sie E-Mail und Nachricht.' }, 400);
  const info = env.MAIL_TO_INFO || 'info@digital-future.ai';
  const server = env.MAIL_TO_SERVER || 'server@digital-future.ai';
  try {
    await sendMail(env, { to: [info, server], reply: email, subject: `[SakanVIP Kontakt] ${subject}`, text: `Von: ${email}\n\n${message}` });
    return json({ ok: true }, 202);
  } catch (err) {
    console.error('Contact mail dispatch failed:', err.message);
    return json({ error: 'Ihre Nachricht konnte momentan nicht versendet werden.' }, 503);
  }
}

async function stripeSession(env, body, origin) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe ist noch nicht konfiguriert.' }, 503);
  try {
    const items = await trustedCart(env, body?.items);
    const shipping = validateShipping(body?.shipping);
    const metadata = { shipping_street: shipping.street, shipping_city: shipping.city, shipping_postal_code: shipping.postalCode, shipping_country: shipping.country, shipping_phone: shipping.phone };
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: items.map(({ product, quantity, size, color, variantId }) => ({
        quantity,
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(Number(product.price) * 100),
          product_data: {
            name: product.name,
            ...(variantText({ size, color }) && { description: variantText({ size, color }) }),
            metadata: { product_id: product.id, variant_id: variantId, size, color }
          }
        }
      })),
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: EU_COUNTRIES },
      // Stripe collects the shipping address itself (shipping_address_collection); it rejects a preset
      // payment_intent_data.shipping alongside it, so the address from the page only goes in the metadata.
      payment_intent_data: { metadata },
      metadata,
      success_url: env.CHECKOUT_SUCCESS_URL || `${origin}/?payment=success`,
      cancel_url: env.CHECKOUT_CANCEL_URL || `${origin}/?payment=cancel`
    });
    return json({ url: session.url, id: session.id, currency: 'EUR' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return json({ error: err instanceof UserError ? err.message : 'Stripe-Checkout konnte nicht gestartet werden.' }, 400);
  }
}

async function paypalOrder(env, body, origin) {
  if (!paypalReady(env)) return json({ error: 'PayPal ist noch nicht konfiguriert.' }, 503);
  try {
    const items = await trustedCart(env, body?.items);
    const shipping = validateShipping(body?.shipping);
    const total = items.reduce((sum, x) => sum + Number(x.product.price) * x.quantity, 0);
    const token = await paypalAccessToken(env);
    const response = await fetch(paypalBase(env) + '/v2/checkout/orders', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          custom_id: shipping.phone, // the delivery phone, read back when the order is saved
          shipping: {
            name: { full_name: shipping.name || 'SAKANVIP Customer' },
            address: { address_line_1: shipping.street, admin_area_2: shipping.city, postal_code: shipping.postalCode, country_code: shipping.country }
          },
          amount: { currency_code: 'EUR', value: total.toFixed(2), breakdown: { item_total: { currency_code: 'EUR', value: total.toFixed(2) } } },
          items: items.map(({ product, quantity, size, color, variantId }) => ({
            name: String(product.name).slice(0, 127), quantity: String(quantity),
            sku: [product.id, variantId, size, color].join('|').slice(0, 127),
            ...(variantText({ size, color }) && { description: variantText({ size, color }) }),
            unit_amount: { currency_code: 'EUR', value: Number(product.price).toFixed(2) }
          }))
        }],
        application_context: {
          return_url: env.CHECKOUT_SUCCESS_URL || `${origin}/?payment=paypal-approved`,
          cancel_url: env.CHECKOUT_CANCEL_URL || `${origin}/?payment=cancel`
        }
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'PayPal order create failed');
    const approval = data.links?.find(x => x.rel === 'approve')?.href;
    if (!approval) throw new Error('PayPal approval URL missing');
    return json({ id: data.id, url: approval });
  } catch (err) {
    console.error('PayPal order error:', err.message);
    return json({ error: err instanceof UserError ? err.message : 'PayPal-Checkout konnte nicht gestartet werden.' }, 400);
  }
}

async function paypalCapture(env, body, ctx) {
  if (!paypalReady(env)) return json({ error: 'PayPal ist noch nicht konfiguriert.' }, 503);
  const orderId = String(body?.orderId || '');
  if (!/^[A-Z0-9-]{8,64}$/i.test(orderId)) return json({ error: 'Ungültige PayPal-Bestellnummer.' }, 400);
  try {
    const token = await paypalAccessToken(env);
    const response = await fetch(paypalBase(env) + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() },
      body: '{}'
    });
    const data = await response.json();
    if (!response.ok || data.status !== 'COMPLETED') throw new Error(data.message || 'Capture not completed');
    // The payment is done; a failed order email must not show the customer an error.
    try {
      const order = await recordPaypalOrder(env, token, orderId);
      ctx?.waitUntil(sendToCj(env, order, sendMail));
    } catch (err) { console.error('PayPal order record failed:', orderId, err.message); }
    return json({ ok: true, status: data.status, id: data.id });
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    return json({ error: 'PayPal-Zahlung konnte nicht abgeschlossen werden.' }, 400);
  }
}

async function recordPaypalOrder(env, token, orderId) {
  const response = await fetch(paypalBase(env) + '/v2/checkout/orders/' + encodeURIComponent(orderId), { headers: { Authorization: 'Bearer ' + token } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'PayPal order lookup failed');
  const unit = data.purchase_units?.[0] || {};
  const a = unit.shipping?.address || {};
  const shipping = { name: unit.shipping?.name?.full_name, line1: a.address_line_1, line2: a.address_line_2, city: a.admin_area_2, postal_code: a.postal_code, country: a.country_code };
  return recordPaidOrder(env, {
    provider: 'paypal',
    reference: orderId,
    customer: { name: [data.payer?.name?.given_name, data.payer?.name?.surname].filter(Boolean).join(' ') || shipping.name, email: data.payer?.email_address, phone: unit.custom_id || data.payer?.phone?.phone_number?.national_number },
    shipping,
    billing: null,
    items: (unit.items || []).map(item => {
      const [product_id, variant_id, size, color] = String(item.sku || '').split('|');
      return { product_id, variant_id: variant_id || null, name: item.name, size, color, quantity: Number(item.quantity), unit_price: Number(item.unit_amount?.value) };
    }),
    total: Number(unit.amount?.value)
  }, sendMail);
}

async function recordStripeOrder(env, stripe, session) {
  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
  const details = session.customer_details || {};
  const ship = session.collected_information?.shipping_details || session.shipping_details || {};
  return recordPaidOrder(env, {
    provider: 'stripe',
    reference: session.id,
    customer: { name: details.name || ship.name, email: details.email, phone: session.metadata?.shipping_phone || details.phone },
    shipping: { name: ship.name, ...(ship.address || details.address) },
    billing: details.address ? { name: details.name, ...details.address } : null,
    items: lines.data.map(line => {
      const meta = line.price?.product?.metadata || {};
      return { product_id: meta.product_id, variant_id: meta.variant_id || null, name: line.price?.product?.name || line.description, size: meta.size, color: meta.color, quantity: line.quantity, unit_price: line.price.unit_amount / 100 };
    }),
    total: session.amount_total / 100
  }, sendMail);
}

// Stripe calls this server-to-server, so it has no Origin header and needs the raw body for the signature.
async function stripeWebhook(env, request, ctx) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return new Response('Stripe webhook is not configured.', { status: 503 });
  const signature = request.headers.get('stripe-signature');
  const raw = await request.text();
  if (!signature || !raw) return new Response('Missing Stripe signature or raw request body.', { status: 400 });
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return new Response('Invalid Stripe signature.', { status: 400 });
  }
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      console.log('Stripe payment completed:', event.data.object.id, event.data.object.payment_status);
      if (event.data.object.payment_status !== 'paid') break; // delayed methods arrive as async_payment_succeeded
      try {
        const order = await recordStripeOrder(env, stripe, event.data.object);
        // The CJ order runs after Stripe gets its answer; failures are kept on the order and retried by the cron.
        ctx?.waitUntil(sendToCj(env, order, sendMail));
      } catch (err) {
        // 500 makes Stripe retry; recordPaidOrder skips what is already done.
        console.error('Stripe order record failed:', event.data.object.id, err.message);
        return new Response('Order could not be recorded.', { status: 500 });
      }
      break;
    case 'checkout.session.async_payment_failed':
      console.warn('Stripe asynchronous payment failed:', event.data.object.id);
      break;
    default:
      console.log('Stripe webhook event received:', event.type);
  }
  return json({ received: true });
}

// Read-only CJ MCP tools for the shop owner; protected by CJ_MCP_ADMIN_TOKEN.
async function cjAdmin(env, request, pathname) {
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.CJ_MCP_ADMIN_TOKEN || !supplied || !(await safeEqual(supplied, env.CJ_MCP_ADMIN_TOKEN))) return json({ error: 'Unauthorized' }, 401);
  if (pathname === '/api/cj/status') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    try {
      const { tools = [] } = await withCjClient(env, client => client.listTools());
      return json({ configured: true, tools: tools.map(t => ({ name: t.name, description: t.description || '' })) });
    } catch (err) {
      console.error('CJ MCP connection failed:', err.message);
      return json({ error: 'CJ MCP connection unavailable.' }, 503);
    }
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Ungültige Anfrage.' }, 400); }
  const name = String(body?.name || '');
  if (!CJ_READ_TOOLS.includes(name)) return json({ error: 'Tool is not enabled for this read-only endpoint.' }, 400);
  try {
    const result = await withCjClient(env, async client => {
      const response = await client.callTool({ name, arguments: body?.arguments || {} });
      if (response.isError) throw new Error('CJ MCP returned a tool error');
      return response;
    });
    return json({ result });
  } catch (err) {
    console.error('CJ MCP tool failed:', name, err.message);
    return json({ error: 'CJ tool request failed.' }, 502);
  }
}

const routes = {
  '/api/contact': (env, body) => contact(env, body),
  '/api/payments/stripe/session': stripeSession,
  '/api/payments/paypal/order': paypalOrder,
  '/api/payments/paypal/capture': (env, body, origin, ctx) => paypalCapture(env, body, ctx)
};

export default {
  async scheduled(controller, env, ctx) {
    // One after the other: CJ allows about one request per second.
    ctx.waitUntil(retryCjOrders(env, sendMail).finally(() => checkCjTracking(env, sendMail)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/api/payments/stripe/webhook') {
      return request.method === 'POST' ? stripeWebhook(env, request, ctx) : json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }
    if (url.pathname === '/api/cj/status' || url.pathname === '/api/cj/read-tool') return cjAdmin(env, request, url.pathname);
    const handler = routes[url.pathname];
    if (!handler) return url.pathname.startsWith('/api/') ? json({ error: 'Not found' }, 404) : env.ASSETS.fetch(request);

    // Same-origin by default; set ALLOWED_ORIGIN only if the storefront is served from elsewhere.
    const allowed = env.ALLOWED_ORIGIN || url.origin;
    const origin = request.headers.get('Origin');
    if (origin && origin !== allowed) return json({ error: 'Origin not allowed' }, 403);
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });

    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: `${ip}:${url.pathname}` });
      if (!success) return json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' }, 429, cors);
    }

    const raw = await request.text();
    if (raw.length > 12 * 1024) return json({ error: 'Anfrage zu groß.' }, 413, cors);
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: 'Ungültige Anfrage.' }, 400, cors); }

    const response = await handler(env, body, url.origin, ctx);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  }
};
