import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
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
const app = express();
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

app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(port,'0.0.0.0',()=>console.log(`SakanVIP API listening on ${port}; SMTP host ${process.env.SMTP_HOST} port ${smtpPort}`));
