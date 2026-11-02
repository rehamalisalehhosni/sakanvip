// Paid orders: saves the order in Supabase (public.orders) with a gap-free invoice number, renders the
// invoice PDF in the store's name and emails it to the customer, with a copy to the shop.
// Called from the Stripe webhook and the PayPal capture; safe to call twice for the same payment.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const euro = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);
const berlinDate = date => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
export const variantText = item => [item.size && `Größe: ${item.size}`, item.color && `Farbe: ${item.color}`].filter(Boolean).join(' · ');
export const addressLines = a => (a ? [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.country] : []).filter(Boolean).map(String);

// Supabase REST as the service role (orders have RLS on and no policies).
async function supabase(env, path, init = {}) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  // New sb_secret_ keys go in the apikey header only; legacy service_role JWTs also as Bearer.
  const auth = key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` };
  const response = await fetch(new URL('/rest/v1/' + path, env.SUPABASE_URL), {
    ...init,
    headers: { apikey: key, ...auth, 'Content-Type': 'application/json', ...init.headers }
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Supabase ${path.split('?')[0]}: ${response.status} ${text.slice(0, 200)}`), { status: response.status });
  return text ? JSON.parse(text) : null;
}

const findOrder = async (env, reference) =>
  (await supabase(env, `orders?payment_reference=eq.${encodeURIComponent(reference)}&select=*`))[0] || null;

async function createOrder(env, order) {
  const invoiceNumber = await supabase(env, 'rpc/next_invoice_number', { method: 'POST', body: '{}' });
  try {
    const [row] = await supabase(env, 'orders', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        invoice_number: invoiceNumber,
        payment_provider: order.provider,
        payment_reference: order.reference,
        customer_name: order.customer.name,
        customer_email: order.customer.email,
        shipping_address: order.shipping,
        billing_address: order.billing,
        items: order.items,
        total: order.total,
        currency: 'EUR'
      })
    });
    return row;
  } catch (err) {
    if (err.status === 409) return findOrder(env, order.reference); // a parallel call saved it first
    throw err;
  }
}

// Standard PDF fonts only cover WinAnsi (Latin-1 + €); other letters lose their accent or become "?".
const BASE_LETTER = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i' };
function encodable(font, value) {
  return [...String(value ?? '')].map(ch => {
    for (const candidate of [ch, BASE_LETTER[ch], ch.normalize('NFD').replace(/[̀-ͯ]/g, '')].filter(Boolean)) {
      try { font.encodeText(candidate); return candidate; } catch {}
    }
    return '?';
  }).join('');
}

function wrap(font, size, text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
  }
  return line ? [...lines, line] : lines;
}

export async function invoicePdf(env, order) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(`Rechnung ${order.invoice_number}`);
  pdf.setAuthor(env.SHOP_NAME || 'SAKANVIP');
  let page = pdf.addPage([595, 842]);
  const gold = rgb(0.83, 0.69, 0.22), ink = rgb(0.08, 0.08, 0.08), grey = rgb(0.35, 0.35, 0.35);
  const L = 50, R = 545;
  const text = (value, x, y, { font = regular, size = 9, color = ink, align = 'left' } = {}) => {
    const clean = encodable(font, value);
    const dx = align === 'right' ? -font.widthOfTextAtSize(clean, size) : 0;
    page.drawText(clean, { x: x + dx, y, size, font, color });
  };

  page.drawRectangle({ x: 0, y: 830, width: 595, height: 12, color: gold });
  text(env.SHOP_NAME || 'SAKANVIP', L, 790, { font: bold, size: 20 });
  const seller = [env.SHOP_LEGAL_NAME, ...String(env.SHOP_ADDRESS || '').split('|'), env.SHOP_TAX_ID, env.MAIL_TO_INFO].map(s => String(s || '').trim()).filter(Boolean);
  seller.forEach((line, i) => text(line, R, 795 - i * 12, { size: 8, color: grey, align: 'right' }));

  text('RECHNUNG / INVOICE', L, 720, { font: bold, size: 18 });
  const created = new Date(order.created_at || Date.now());
  [
    ['Rechnungsnummer', order.invoice_number],
    ['Rechnungsdatum', berlinDate(created)],
    ['Leistungsdatum', 'entspricht dem Rechnungsdatum'],
    ['Zahlungsart', order.payment_provider === 'paypal' ? 'PayPal' : 'Stripe (Karte / Wallet)'],
    ['Zahlungsreferenz', order.payment_reference],
    ['Status', 'Bezahlt']
  ].forEach(([label, value], i) => {
    text(label + ':', L, 696 - i * 13, { color: grey });
    text(value, L + 95, 696 - i * 13);
  });

  text('Rechnungsempfänger', 340, 696, { font: bold });
  const customer = [order.customer_name, order.customer_email, ...addressLines(order.billing_address || order.shipping_address)].filter(Boolean);
  customer.forEach((line, i) => text(line, 340, 682 - i * 12, { color: grey }));
  let y = Math.min(600, 682 - customer.length * 12 - 14);
  text('Lieferadresse', 340, y, { font: bold });
  [order.shipping_address?.name || order.customer_name, ...addressLines(order.shipping_address)].filter(Boolean)
    .forEach((line, i) => text(line, 340, y - 14 - i * 12, { color: grey }));

  y = Math.min(y - 90, 520);
  const cols = { pos: L + 6, name: L + 30, qty: 400, unit: 470, total: R - 6 };
  const header = () => {
    page.drawRectangle({ x: L, y: y - 6, width: R - L, height: 20, color: ink });
    text('Pos.', cols.pos, y, { font: bold, size: 8, color: gold });
    text('Artikel', cols.name, y, { font: bold, size: 8, color: gold });
    text('Menge', cols.qty, y, { font: bold, size: 8, color: gold, align: 'right' });
    text('Einzelpreis', cols.unit, y, { font: bold, size: 8, color: gold, align: 'right' });
    text('Gesamt', cols.total, y, { font: bold, size: 8, color: gold, align: 'right' });
    y -= 26;
  };
  header();
  order.items.forEach((item, i) => {
    const lines = wrap(regular, 9, encodable(regular, item.name), 300);
    const variant = variantText(item);
    const height = lines.length * 12 + (variant ? 12 : 0) + 10;
    if (y - height < 140) { page = pdf.addPage([595, 842]); y = 790; header(); }
    text(String(i + 1), cols.pos, y);
    lines.forEach((line, j) => text(line, cols.name, y - j * 12));
    if (variant) text(variant, cols.name, y - lines.length * 12, { size: 8, color: grey });
    text(String(item.quantity), cols.qty, y, { align: 'right' });
    text(euro(item.unit_price), cols.unit, y, { align: 'right' });
    text(euro(item.unit_price * item.quantity), cols.total, y, { align: 'right' });
    y -= height;
    page.drawLine({ start: { x: L, y: y + 13 }, end: { x: R, y: y + 13 }, thickness: 0.5, color: rgb(0.89, 0.85, 0.72) });
  });

  // Prices are gross (consumer prices incl. VAT). SHOP_VAT_RATE=0 means small business (§ 19 UStG).
  const rate = Number(env.SHOP_VAT_RATE ?? 19);
  const total = Number(order.total);
  y -= 10;
  const sum = (label, value, opts) => { text(label, cols.unit, y, { align: 'right', ...opts }); text(value, cols.total, y, { align: 'right', ...opts }); y -= 14; };
  if (rate > 0) {
    const vat = Math.round(total * rate / (100 + rate) * 100) / 100;
    sum('Nettobetrag', euro(total - vat));
    sum(`zzgl. ${rate} % USt.`, euro(vat));
  }
  sum('Versand', euro(0));
  sum('Gesamtbetrag', euro(total), { font: bold, size: 11 });
  y -= 10;
  const notes = [
    rate > 0 ? 'Alle Preise enthalten die gesetzliche Umsatzsteuer.' : 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    'Vielen Dank für Ihren Einkauf bei ' + (env.SHOP_NAME || 'SAKANVIP') + '. Der Betrag wurde bereits bezahlt.'
  ];
  notes.forEach(line => { text(line, L, y, { size: 8, color: grey }); y -= 12; });
  return pdf.saveAsBase64();
}

function confirmationText(env, order) {
  const items = order.items.map(item =>
    `- ${item.quantity} x ${item.name}${variantText(item) ? ` (${variantText(item)})` : ''}: ${euro(item.unit_price * item.quantity)}`);
  return [
    `Guten Tag ${order.customer_name || ''},`.trim(),
    '',
    `vielen Dank für Ihre Bestellung bei ${env.SHOP_NAME || 'SAKANVIP'}. Ihre Zahlung ist eingegangen.`,
    '',
    `Rechnungsnummer: ${order.invoice_number}`,
    ...items,
    `Gesamtbetrag: ${euro(order.total)}`,
    '',
    'Lieferadresse:',
    ...[order.shipping_address?.name || order.customer_name, ...addressLines(order.shipping_address)].filter(Boolean),
    '',
    'Ihre Rechnung finden Sie im Anhang (PDF). Sobald Ihre Bestellung versandt ist, erhalten Sie die Sendungsnummer per E-Mail.',
    '',
    `Mit freundlichen Grüßen\n${env.SHOP_NAME || 'SAKANVIP'}`
  ].join('\n');
}

// order: { provider, reference, customer: { name, email }, shipping, billing, items: [{ product_id, name, size, color, quantity, unit_price }], total }
export async function recordPaidOrder(env, order, sendMail) {
  let row = await findOrder(env, order.reference);
  if (!row) row = await createOrder(env, order);
  if (row.invoice_sent_at) return row;

  const pdf = await invoicePdf(env, row);
  const attachments = [{ filename: `Rechnung-${row.invoice_number}.pdf`, content: pdf, mimeType: 'application/pdf' }];
  const shop = env.MAIL_TO_INFO || 'info@digital-future.ai';
  const subject = `Ihre Bestellung bei ${env.SHOP_NAME || 'SAKANVIP'} – Rechnung ${row.invoice_number}`;
  const text = confirmationText(env, row);
  if (row.customer_email) await sendMail(env, { to: row.customer_email, reply: shop, subject, text, attachments });
  // The shop's copy carries the customer's contact data for the supplier order.
  await sendMail(env, {
    to: shop,
    subject: `[SakanVIP Bestellung] ${row.invoice_number} – ${euro(row.total)}`,
    text: `Neue bezahlte Bestellung (${row.payment_provider}, ${row.payment_reference}).\nKunde: ${row.customer_name || '—'} <${row.customer_email || 'keine E-Mail'}>\n\n${text}`,
    attachments
  });
  await supabase(env, `orders?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ invoice_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return row;
}
