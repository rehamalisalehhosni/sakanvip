-- Paid orders, one row per Stripe Checkout session or PayPal order. Written only by the Worker
-- (service role); RLS is on with no policies, so the browser cannot read or change orders.
create sequence if not exists public.invoice_number_seq;
create table if not exists public.orders (
 id uuid primary key default gen_random_uuid(),
 invoice_number text not null unique,
 payment_provider text not null check (payment_provider in ('stripe', 'paypal')),
 payment_reference text not null unique,
 status text not null default 'paid' check (status in ('paid', 'sent_to_supplier', 'shipped', 'delivered', 'cancelled', 'refunded')),
 customer_name text, customer_email text,
 shipping_address jsonb, billing_address jsonb,
 items jsonb not null,
 total numeric(12,2) not null, currency text not null default 'EUR',
 invoice_sent_at timestamptz,
 supplier_order_id text, tracking_number text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.orders enable row level security;
revoke all on public.orders from anon, authenticated;
-- Gap-free invoice numbers (SV-2026-00001): only called for a payment that has no order yet.
create or replace function public.next_invoice_number() returns text language sql security definer set search_path = public as $$
 select 'SV-' || to_char(now() at time zone 'Europe/Berlin', 'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0')
$$;
revoke all on function public.next_invoice_number() from public, anon, authenticated;
