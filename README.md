# sakanvip

SakanVIP storefront. Runs on **Cloudflare Workers**: one Worker serves the static page
(`index.html` + images) and the API routes it calls.

| Route | Purpose |
| --- | --- |
| `POST /api/contact` | Sends contact form messages to `info@` and `server@` via UDAG SMTP |
| `POST /api/payments/stripe/session` | Creates a Stripe Checkout session; prices re-checked in Supabase |
| `POST /api/payments/paypal/order` | Creates a PayPal order; prices re-checked in Supabase |
| `POST /api/payments/paypal/capture` | Captures an approved PayPal order |
| `POST /api/payments/stripe/webhook` | Stripe events (signature-checked); saves the paid order and emails the invoice |
| `GET /api/cj/status`, `POST /api/cj/read-tool` | Read-only CJ MCP tools for the owner (needs `CJ_MCP_ADMIN_TOKEN`) |
| `GET /health` | Health check |

Accounts, login and carts use Supabase directly from the page (`supabase/schema.sql`).
The old Express + SQLite API in `server/` is no longer needed on Cloudflare.

## Run locally

```bash
npm install
npm run dev
```

Secrets for local runs go in a git-ignored `.dev.vars` file (same names as below).

## Deploy on Cloudflare

Cloudflare dashboard → Workers & Pages → Create → Import a repository → `sakan-app/sakanvip`:

- Project name: `sakanvip-cf`
- Build command: *(leave empty)*
- Deploy command: `npx wrangler deploy`

Public settings are in `wrangler.jsonc` (`vars`). Add these in the Worker's
**Settings → Variables and secrets** as type **Secret**, then click **Deploy**:

| Secret | Needed for |
| --- | --- |
| `SMTP_PASS` | Contact form email (UDAG mailbox password for `info@digital-future.ai`) |
| `STRIPE_SECRET_KEY` | Stripe Checkout |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook (`whsec_…` from the Stripe endpoint for `/api/payments/stripe/webhook`) |
| `CJ_MCP_TOKEN`, `CJ_MCP_ADMIN_TOKEN` | CJ MCP admin endpoints |
| `SUPABASE_SERVICE_ROLE_KEY` | Saving paid orders (Supabase → Project Settings → API Keys → secret key) |

## Orders and invoices

When a Stripe or PayPal payment succeeds, the Worker saves the order in `public.orders`
(`supabase/migrations/20261102_orders.sql`) with a gap-free invoice number (`SV-2026-00001`),
then emails the customer a PDF invoice in the store's name (items with size and colour, total,
addresses) and sends a copy with the customer's contact data to `MAIL_TO_INFO`.
The seller data on the invoice comes from the `SHOP_*` vars in `wrangler.jsonc`.
The Stripe webhook must send `checkout.session.completed` and `checkout.session.async_payment_succeeded`.

Optional: `CHECKOUT_SUCCESS_URL`, `CHECKOUT_CANCEL_URL` (default: the site's own address).
In Supabase → Authentication → URL Configuration, set the Site URL and add the Worker
address to the redirect URLs.
