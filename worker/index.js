// SakanVIP on Cloudflare Workers: serves the static storefront (assets) and the API routes
// the storefront calls. Ported from server/server.js (Express); accounts and carts live in
// Supabase (auth + cart_items), so the old SQLite register/verify/subscribe routes are not needed.
import Stripe from 'stripe';
import { WorkerMailer } from 'worker-mailer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailOk = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

class UserError extends Error {}

// "SakanVIP <info@example.com>" -> { name, email }
function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  return match ? { name: match[1].replace(/^"|"$/g, ''), email: match[2] } : { email: String(value || '').trim() };
}

async function trustedCart(env, items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new UserError('Warenkorb ungültig.');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error('Produktdatenbank ist nicht konfiguriert.');
  const normalized = items.map(x => ({ id: String(x?.product_id || ''), quantity: Number(x?.quantity) }));
  if (normalized.some(x => !UUID.test(x.id) || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 20)) {
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
  return normalized.map(x => ({ product: byId.get(x.id), quantity: x.quantity }));
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
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items.map(({ product, quantity }) => ({
        quantity, price_data: { currency: 'eur', unit_amount: Math.round(Number(product.price) * 100), product_data: { name: product.name } }
      })),
      success_url: env.CHECKOUT_SUCCESS_URL || `${origin}/?payment=success`,
      cancel_url: env.CHECKOUT_CANCEL_URL || `${origin}/?payment=cancel`
    });
    return json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return json({ error: err instanceof UserError ? err.message : 'Stripe-Checkout konnte nicht gestartet werden.' }, 400);
  }
}

async function paypalOrder(env, body, origin) {
  if (!paypalReady(env)) return json({ error: 'PayPal ist noch nicht konfiguriert.' }, 503);
  try {
    const items = await trustedCart(env, body?.items);
    const total = items.reduce((sum, x) => sum + Number(x.product.price) * x.quantity, 0);
    const token = await paypalAccessToken(env);
    const response = await fetch(paypalBase(env) + '/v2/checkout/orders', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'EUR', value: total.toFixed(2), breakdown: { item_total: { currency_code: 'EUR', value: total.toFixed(2) } } },
          items: items.map(({ product, quantity }) => ({
            name: String(product.name).slice(0, 127), quantity: String(quantity),
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

async function paypalCapture(env, body) {
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
    return json({ ok: true, status: data.status, id: data.id });
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    return json({ error: 'PayPal-Zahlung konnte nicht abgeschlossen werden.' }, 400);
  }
}

const routes = {
  '/api/contact': (env, body) => contact(env, body),
  '/api/payments/stripe/session': stripeSession,
  '/api/payments/paypal/order': paypalOrder,
  '/api/payments/paypal/capture': (env, body) => paypalCapture(env, body)
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
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

    const response = await handler(env, body, url.origin);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  }
};
