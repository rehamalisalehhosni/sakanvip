-- CJ fulfilment state per order (written by worker/cj.js).
alter table public.orders add column if not exists supplier_shipment_id text;
alter table public.orders add column if not exists supplier_logistic text;
alter table public.orders add column if not exists supplier_paid_at timestamptz;
alter table public.orders add column if not exists supplier_error text;
