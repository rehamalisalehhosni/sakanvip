// Sends paid orders to CJ Dropshipping: creates the CJ order with the customer's address, phone and the
// exact CJ variants, using CJ's cheapest shipping method, and pays it from the CJ wallet when
// CJ_AUTO_PAY is "on". Otherwise the order waits in CJ for the owner to pay.
// Called right after an order is saved and every 30 minutes for orders that are still waiting.
import { supabase } from './orders.js';

const CJ = 'https://developers.cjdropshipping.com/api2.0/v1/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });

// CJ access tokens last 180 days and getAccessToken returns the same token within 24 hours,
// so one per Worker instance is enough.
let token = null;
async function cjToken(env) {
  if (token) return token;
  if (!env.CJ_API_KEY) throw new Error('CJ_API_KEY is not configured');
  const response = await fetch(CJ + 'authentication/getAccessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: env.CJ_API_KEY })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.data?.accessToken) throw new Error(`CJ token: ${body?.message || response.status}`);
  token = body.data.accessToken;
  return token;
}

// CJ allows about one request per second.
async function cj(env, path, init = {}) {
  await sleep(1100);
  const response = await fetch(CJ + path, {
    ...init, headers: { 'CJ-Access-Token': await cjToken(env), 'Content-Type': 'application/json', ...init.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.result === false) throw new Error(`CJ ${path.split('?')[0]}: ${body.message || response.status}`);
  return body.data;
}

const setOrder = (env, id, fields) =>
  supabase(env, `orders?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }) });

async function cheapestShipping(env, country, products) {
  const quotes = await cj(env, 'logistic/freightCalculate', {
    method: 'POST', body: JSON.stringify({ startCountryCode: 'CN', endCountryCode: country, products: products.map(p => ({ vid: p.vid, quantity: p.quantity })) })
  });
  const best = (quotes || []).filter(q => Number(q.logisticPrice) > 0).sort((a, b) => a.logisticPrice - b.logisticPrice)[0];
  if (!best) throw new Error(`CJ has no shipping route from CN to ${country}`);
  return best.logisticName;
}

// Returns the order row as saved afterwards. Never throws: problems are stored in supplier_error.
export async function sendToCj(env, order) {
  if (!order || order.status !== 'paid' || order.supplier_order_id) return order;
  try {
    if (order.items.some(i => !i.variant_id)) throw new Error('An item has no CJ variant');
    const variantIds = [...new Set(order.items.map(i => i.variant_id))];
    const variants = await supabase(env, `product_variants?id=in.(${variantIds.join(',')})&select=id,cj_vid`);
    const vidOf = new Map(variants.map(v => [v.id, v.cj_vid]));
    const products = order.items.map((item, i) => {
      if (!vidOf.get(item.variant_id)) throw new Error(`No CJ variant for ${item.name}`);
      return { vid: vidOf.get(item.variant_id), quantity: Number(item.quantity), storeLineItemId: `${order.invoice_number}-${i + 1}` };
    });

    const a = order.shipping_address || {};
    const country = String(a.country || '').toUpperCase();
    const logisticName = await cheapestShipping(env, country, products);
    const sandbox = env.CJ_SANDBOX === 'on';
    const created = await cj(env, 'shopping/order/createOrderV2', {
      method: 'POST',
      body: JSON.stringify({
        orderNumber: sandbox ? `${order.invoice_number}-TEST-${Date.now()}` : order.invoice_number,
        shippingCountryCode: country,
        shippingCountry: regionName.of(country) || country,
        shippingProvince: a.state || a.city || '',
        shippingCity: a.city || '',
        shippingZip: a.postal_code || '',
        shippingCustomerName: String(a.name || order.customer_name || '').slice(0, 50),
        shippingAddress: String(a.line1 || '').slice(0, 500),
        shippingAddress2: String(a.line2 || '').slice(0, 500),
        shippingPhone: String(order.customer_phone || '').slice(0, 20),
        email: String(order.customer_email || '').slice(0, 50),
        remark: `SAKANVIP ${order.invoice_number}`,
        logisticName,
        fromCountryCode: 'CN',
        payType: 3, // create only; payment below
        iossType: Number(env.CJ_IOSS_TYPE || 3), // 3 = CJ collects EU import VAT, so the customer pays nothing at the door
        isSandbox: sandbox ? 1 : 0,
        storeName: env.SHOP_NAME || 'SAKANVIP',
        products
      })
    });
    order = { ...order, supplier_order_id: created.orderId, supplier_shipment_id: created.shipmentOrderId, supplier_logistic: logisticName };
    await setOrder(env, order.id, {
      status: 'sent_to_supplier', supplier_order_id: created.orderId, supplier_shipment_id: created.shipmentOrderId,
      supplier_logistic: logisticName, supplier_error: null
    });
    order.status = 'sent_to_supplier';
    if (env.CJ_AUTO_PAY === 'on') order = await payCj(env, order);
  } catch (err) {
    console.error('CJ order failed:', order.invoice_number, err.message);
    await setOrder(env, order.id, { supplier_error: String(err.message).slice(0, 500) }).catch(() => {});
    order = { ...order, supplier_error: err.message };
  }
  return order;
}

// Pays a created CJ order from the CJ wallet.
export async function payCj(env, order) {
  if (!order.supplier_shipment_id || order.supplier_paid_at) return order;
  await cj(env, 'shopping/pay/payBalanceV2', { method: 'POST', body: JSON.stringify({ shipmentOrderId: order.supplier_shipment_id }) });
  const paidAt = new Date().toISOString();
  await setOrder(env, order.id, { supplier_paid_at: paidAt, supplier_error: null });
  return { ...order, supplier_paid_at: paidAt, supplier_error: null };
}

// Cron: orders paid in the last 30 days that are not at CJ yet, or created there but unpaid (auto-pay on).
export async function retryCjOrders(env) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const waiting = await supabase(env, `orders?status=eq.paid&supplier_order_id=is.null&created_at=gte.${since}&select=*&order=created_at&limit=10`);
  for (const order of waiting) await sendToCj(env, order);
  if (env.CJ_AUTO_PAY !== 'on') return;
  const unpaid = await supabase(env, `orders?status=eq.sent_to_supplier&supplier_paid_at=is.null&created_at=gte.${since}&select=*&order=created_at&limit=10`);
  for (const order of unpaid) {
    try { await payCj(env, order); } catch (err) {
      console.error('CJ payment failed:', order.invoice_number, err.message);
      await setOrder(env, order.id, { supplier_error: String(err.message).slice(0, 500) }).catch(() => {});
    }
  }
}
