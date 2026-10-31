import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import fs from 'node:fs';
import path from 'node:path';

const required = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','MAIL_FROM','PUBLIC_API_URL','ALLOWED_ORIGIN'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const port = Number(process.env.PORT || 3000);
const smtpPort = Number(process.env.SMTP_PORT);
if (![465,587].includes(smtpPort)) throw new Error('SMTP_PORT must be 465 (TLS) or 587 (STARTTLS)');
const secure = smtpPort === 465;
const dbFile = path.resolve(process.env.DATABASE_FILE || './data/sakanvip.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 verified_at TEXT,
 verification_hash TEXT,
 verification_expires INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id INTEGER PRIMARY KEY,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 confirmed_at TEXT,
 confirmation_hash TEXT,
 confirmation_expires INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const paypalBase = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const paypalReady = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
async function trustedCart(items) {
 if (!Array.isArray(items) || !items.length || items.length > 50) throw new Error('Warenkorb ungültig.');
 if (!supabaseUrl || !supabaseAnonKey) throw new Error('Produktdatenbank ist nicht konfiguriert.');
 const normalized = items.map(x=>({id:String(x.product_id||''),quantity:Number(x.quantity)}));
 if (normalized.some(x=>!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(x.id)||!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>20)) throw new Error('Warenkorbposition ungültig.');
 const ids=[...new Set(normalized.map(x=>x.id))];
 const url=new URL('/rest/v1/products',supabaseUrl);
 url.searchParams.set('select','id,name,price,active');
 url.searchParams.set('id',`in.(${ids.join(',')})`);
 url.searchParams.set('active','eq.true');
 const response=await fetch(url,{headers:{apikey:supabaseAnonKey,Authorization:`Bearer ${supabaseAnonKey}`}});
 if(!response.ok) throw new Error('Produktdaten konnten nicht geladen werden.');
 const products=await response.json();
 const byId=new Map(products.map(p=>[p.id,p]));
 if(ids.some(id=>!byId.has(id))) throw new Error('Ein Produkt ist nicht verfügbar.');
 return normalized.map(x=>({product:byId.get(x.id),quantity:x.quantity}));
}
async function paypalAccessToken(){
 const auth=Buffer.from(process.env.PAYPAL_CLIENT_ID+':'+process.env.PAYPAL_CLIENT_SECRET).toString('base64');
 const r=await fetch(paypalBase+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
 const data=await r.json();if(!r.ok||!data.access_token)throw new Error('PayPal Auth fehlgeschlagen.');return data.access_token;
}
\nconst app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '12kb' }));
app.use((req,res,next)=>{
 const origin=req.get('origin');
 if(origin && origin!==process.env.ALLOWED_ORIGIN) return res.status(403).json({error:'Origin not allowed'});
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
 if(req.method==='OPTIONS') return res.sendStatus(204);
 next();
});
const limiter=rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false,message:{error:'Zu viele Versuche. Bitte später erneut versuchen.'}});
const mailer=nodemailer.createTransport({host:process.env.SMTP_HOST,port:smtpPort,secure, requireTLS:!secure,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},tls:{minVersion:'TLSv1.2'}});
const emailOk=value=>typeof value==='string' && value.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const userByEmail=db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE');
const createUser=db.prepare('INSERT INTO users(email,password_hash,verification_hash,verification_expires) VALUES(?,?,?,?)');
const createSubscription=db.prepare('INSERT INTO subscriptions(email,confirmation_hash,confirmation_expires) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET confirmation_hash=excluded.confirmation_hash,confirmation_expires=excluded.confirmation_expires,confirmed_at=NULL');
const confirmSubscription=db.prepare('UPDATE subscriptions SET confirmed_at=CURRENT_TIMESTAMP,confirmation_hash=NULL,confirmation_expires=NULL WHERE confirmation_hash=? AND confirmation_expires>?');
const updateVerified=db.prepare('UPDATE users SET verified_at=CURRENT_TIMESTAMP,verification_hash=NULL,verification_expires=NULL WHERE verification_hash=? AND verification_expires>?');
const publicApi=process.env.PUBLIC_API_URL.replace(/\/$/,'');
const from=process.env.MAIL_FROM;
const info=process.env.MAIL_TO_INFO || 'info@digital-future.ai';
const server=process.env.MAIL_TO_SERVER || 'server@digital-future.ai';

app.post('/api/register',limiter,async(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase();
 const password=String(req.body?.password||'');
 const newsletter=req.body?.newsletter===true;
 if(!emailOk(email)) return res.status(400).json({error:'Bitte geben Sie eine gültige E-Mail-Adresse ein.'});
 if(password.length<12 || password.length>128) return res.status(400).json({error:'Das Passwort muss 12 bis 128 Zeichen lang sein.'});
 if(userByEmail.get(email)) return res.status(409).json({error:'Für diese E-Mail-Adresse besteht bereits ein Konto. Bitte prüfen Sie Ihr Postfach.'});
 const token=crypto.randomBytes(32).toString('base64url');
 const hash=tokenHash(token);
 const newsletterToken=newsletter?crypto.randomBytes(32).toString('base64url'):null;
 const newsletterHash=newsletterToken?tokenHash(newsletterToken):null;
 const passwordHash=await bcrypt.hash(password,12);
 try {
  createUser.run(email,passwordHash,hash,Date.now()+24*60*60*1000);
  if(newsletter) createSubscription.run(email,newsletterHash,Date.now()+24*60*60*1000);
  const link=publicApi+'/api/verify?token='+encodeURIComponent(token);
  const newsletterLink=newsletterToken?publicApi+'/api/verify?type=newsletter&token='+encodeURIComponent(newsletterToken):null;
  await mailer.sendMail({from,to:email,replyTo:info,subject:'Bitte bestätigen Sie Ihre SakanVIP Registrierung',text:`Vielen Dank für Ihre Registrierung bei SakanVIP. Bitte bestätigen Sie Ihre E-Mail-Adresse innerhalb von 24 Stunden: ${link}\n\nFalls Sie diese Registrierung nicht angefordert haben, ignorieren Sie diese Nachricht.${newsletterLink?'\\n\\nFür den freiwilligen VIP-Newsletter bestätigen Sie bitte separat: '+newsletterLink:''}`,html:`<div style="font-family:Arial,sans-serif;background:#100e17;color:#f3e5ab;padding:32px"><h1 style="color:#d4af37">SAKANVIP</h1><p>Vielen Dank für Ihre Registrierung.</p><p><a href="${link}" style="display:inline-block;padding:14px 22px;background:#d4af37;color:#100e17;text-decoration:none;border-radius:24px">E-Mail-Adresse bestätigen</a></p><p>Der Link ist 24 Stunden gültig. Falls Sie diese Registrierung nicht angefordert haben, ignorieren Sie diese Nachricht.</p>${newsletterLink?`<p>Sie haben den VIP-Newsletter ausgewählt. <a href="${newsletterLink}" style="color:#d4af37">Newsletter-Anmeldung separat bestätigen</a>.</p>`:''}</div>`});
  res.status(202).json({ok:true,message:'confirmation_sent'});
 } catch(err) {
  db.prepare('DELETE FROM users WHERE email=? AND verified_at IS NULL').run(email);
  console.error('Registration mail dispatch failed:',err.message);
  res.status(503).json({error:'Die Bestätigungs-E-Mail konnte momentan nicht versendet werden. Bitte versuchen Sie es später erneut.'});
 }
});

app.get('/api/verify',limiter,(req,res)=>{
 const token=String(req.query.token||'');
 if(!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return res.status(400).send('Ungültiger oder abgelaufener Bestätigungslink.');
 if(req.query.type==='newsletter') { const sub=confirmSubscription.run(tokenHash(token),Date.now()); if(!sub.changes) return res.status(400).send('Der Newsletter-Bestätigungslink ist ungültig oder abgelaufen.'); return res.type('html').send('<!doctype html><html lang="de"><meta charset="utf-8"><body style="background:#100e17;color:#f3e5ab;font:18px Arial;padding:10vh 8vw"><h1 style="color:#d4af37">SAKANVIP</h1><p>Ihre VIP-Newsletter-Anmeldung wurde bestätigt.</p></body></html>'); }
 const result=updateVerified.run(tokenHash(token),Date.now());
 if(!result.changes) return res.status(400).send('Der Bestätigungslink ist ungültig oder abgelaufen. Bitte registrieren Sie sich erneut.');
 res.type('html').send('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SakanVIP bestätigt</title><body style="background:#100e17;color:#f3e5ab;font:18px Arial;padding:10vh 8vw"><h1 style="color:#d4af37">SAKANVIP</h1><p>Ihre E-Mail-Adresse wurde bestätigt. Ihre Registrierung ist abgeschlossen.</p><a style="color:#d4af37" href="https://sakan-app.github.io/sakanvip/">Zum Shop</a></body></html>');
});

app.post('/api/subscribe',limiter,async(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase();
 if(!emailOk(email)) return res.status(400).json({error:'Bitte geben Sie eine gültige E-Mail-Adresse ein.'});
 try {
  const token=crypto.randomBytes(32).toString('base64url');
  createSubscription.run(email,tokenHash(token),Date.now()+24*60*60*1000);
  const link=publicApi+'/api/verify?type=newsletter&token='+encodeURIComponent(token);
  await mailer.sendMail({from,to:email,replyTo:info,subject:'SakanVIP – Bitte Newsletter-Anmeldung bestätigen',text:'Bitte bestätigen Sie Ihre freiwillige VIP-Newsletter-Anmeldung innerhalb von 24 Stunden: '+link});
  res.status(202).json({ok:true});
 } catch(err){console.error('Subscription dispatch failed:',err.message);res.status(503).json({error:'Die E-Mail konnte momentan nicht versendet werden.'});}
});

app.post('/api/contact',limiter,async(req,res)=>{
 const email=String(req.body?.email||'').trim();
 const subject=String(req.body?.subject||'SakanVIP Kontaktanfrage').slice(0,160);
 const message=String(req.body?.message||'').trim();
 if(!emailOk(email)||message.length<5||message.length>5000) return res.status(400).json({error:'Bitte prüfen Sie E-Mail und Nachricht.'});
 try {
  await mailer.sendMail({from,to:[info,server],replyTo:email,subject:`[SakanVIP Kontakt] ${subject}`,text:`Von: ${email}\n\n${message}`});
  res.status(202).json({ok:true});
 } catch(err){console.error('Contact mail dispatch failed:',err.message);res.status(503).json({error:'Ihre Nachricht konnte momentan nicht versendet werden.'});}
});


app.post('/api/payments/stripe/session',limiter,async(req,res)=>{
 if(!stripe)return res.status(503).json({error:'Stripe ist noch nicht konfiguriert.'});
 try{
  const items=await trustedCart(req.body?.items);
  const line_items=items.map(({product,quantity})=>({quantity,price_data:{currency:'eur',unit_amount:Math.round(Number(product.price)*100),product_data:{name:product.name}}}));
  const session=await stripe.checkout.sessions.create({mode:'payment',line_items,success_url:process.env.CHECKOUT_SUCCESS_URL||'https://sakan-app.github.io/sakanvip/?payment=success',cancel_url:process.env.CHECKOUT_CANCEL_URL||'https://sakan-app.github.io/sakanvip/?payment=cancel'});
  res.json({url:session.url,id:session.id});
 }catch(err){console.error('Stripe checkout error:',err.message);res.status(400).json({error:'Stripe-Checkout konnte nicht gestartet werden.'});}
});
app.post('/api/payments/paypal/order',limiter,async(req,res)=>{
 if(!paypalReady)return res.status(503).json({error:'PayPal ist noch nicht konfiguriert.'});
 try{
  const items=await trustedCart(req.body?.items);
  const total=items.reduce((sum,x)=>sum+Number(x.product.price)*x.quantity,0);
  const token=await paypalAccessToken();
  const response=await fetch(paypalBase+'/v2/checkout/orders',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','PayPal-Request-Id':crypto.randomUUID()},body:JSON.stringify({intent:'CAPTURE',purchase_units:[{amount:{currency_code:'EUR',value:total.toFixed(2)},items:items.map(({product,quantity})=>({name:String(product.name).slice(0,127),quantity:String(quantity),unit_amount:{currency_code:'EUR',value:Number(product.price).toFixed(2)}}))}],application_context:{return_url:process.env.CHECKOUT_SUCCESS_URL||'https://sakan-app.github.io/sakanvip/?payment=paypal-approved',cancel_url:process.env.CHECKOUT_CANCEL_URL||'https://sakan-app.github.io/sakanvip/?payment=cancel'}})});
  const data=await response.json();if(!response.ok)throw new Error(data.message||'PayPal order create failed');
  const approval=data.links?.find(x=>x.rel==='approve')?.href;if(!approval)throw new Error('PayPal approval URL missing');
  res.json({id:data.id,url:approval});
 }catch(err){console.error('PayPal order error:',err.message);res.status(400).json({error:'PayPal-Checkout konnte nicht gestartet werden.'});}
});
app.post('/api/payments/paypal/capture',limiter,async(req,res)=>{
 if(!paypalReady)return res.status(503).json({error:'PayPal ist noch nicht konfiguriert.'});
 const orderId=String(req.body?.orderId||'');if(!/^[A-Z0-9-]{8,64}$/i.test(orderId))return res.status(400).json({error:'Ungültige PayPal-Bestellnummer.'});
 try{const token=await paypalAccessToken();const response=await fetch(paypalBase+'/v2/checkout/orders/'+encodeURIComponent(orderId)+'/capture',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','PayPal-Request-Id':crypto.randomUUID()},body:'{}'});const data=await response.json();if(!response.ok||data.status!=='COMPLETED')throw new Error(data.message||'Capture not completed');res.json({ok:true,status:data.status,id:data.id});}
 catch(err){console.error('PayPal capture error:',err.message);res.status(400).json({error:'PayPal-Zahlung konnte nicht abgeschlossen werden.'});}
});

app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(port,'0.0.0.0',()=>console.log(`SakanVIP API listening on ${port}; SMTP host ${process.env.SMTP_HOST} port ${smtpPort}`));
