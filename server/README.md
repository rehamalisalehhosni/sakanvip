# SakanVIP API deployment

The static storefront is hosted by GitHub Pages. GitHub Pages does not execute Node.js, SMTP, IMAP or POP3. Deploy this API as a separate Node.js 20+ service (for example, a managed Node host) and use a persistent disk for the SQLite database.

## Configure

1. Deploy this `server/` directory as a Node.js service.
2. Run `npm install` and set the start command to `npm start`.
3. Copy `.env.example` into the hosting provider's secret/environment-variable settings. Do not commit a real `.env`.
4. Set `PUBLIC_API_URL` to the public HTTPS origin of this API, and `ALLOWED_ORIGIN=https://sakan-app.github.io`.
5. Set `SMTP_USER=info@digital-future.ai`, `SMTP_PASS` to the UDAG mailbox password, `MAIL_FROM="SakanVIP <info@digital-future.ai>"`, `MAIL_TO_INFO=info@digital-future.ai`, and `MAIL_TO_SERVER=server@digital-future.ai`.
6. UDAG outbound: `smtps.udag.de`, port `465` with implicit TLS (recommended), or port `587` with STARTTLS. Match `SMTP_SECURE=true` for 465 and `false` for 587.
7. Add a small configuration script before the storefront's main script in `index.html` to set `window.SAKANVIP_API_BASE='https://YOUR-API-HOST'`. Keep this URL public; never put credentials here.
8. Use persistent storage for `DATABASE_FILE`. Back up the database and test email delivery and verification end-to-end before launch.

## Mailbox protocols

- IMAP: `imaps.udag.de:993` (SSL/TLS) or `imaps.udag.de:143` (STARTTLS).
- POP3: `pops.udag.de:995` (SSL/TLS) or `pops.udag.de:110` (STARTTLS).
- SMTP: `smtps.udag.de:465` (SSL/TLS) or `smtps.udag.de:587` (STARTTLS).

IMAP/POP3 are mailbox access protocols, not outbound dispatch mechanisms. This API sends via SMTP and forwards contact submissions to both official addresses. Incoming customer replies remain in the UDAG mailboxes and should be handled through the company's mail client/helpdesk; this code does not poll IMAP/POP3 or ingest inbound mail.

## Implemented routes

- `POST /api/register`: validates email/password, hashes passwords with bcrypt, stores a pending account, and sends a one-time 24-hour verification link.
- `GET /api/verify?token=...`: activates a pending account using a hashed, expiring token.
- `POST /api/subscribe`: sends a separate newsletter double-opt-in link.
- `GET /api/verify?type=newsletter&token=...`: confirms newsletter consent.
- `POST /api/contact`: sends contact submissions to `info@` and `server@`, with the sender as Reply-To.
- `GET /health`: health check.

The UI reports registration success only after the API accepts the request and the SMTP dispatch succeeds. Login/session issuance, password reset, unsubscribe/preferences management, CAPTCHA, transactional email monitoring, and a managed production database still need to be added before this should be treated as a complete production identity platform. The present registration API intentionally does not issue login sessions.
