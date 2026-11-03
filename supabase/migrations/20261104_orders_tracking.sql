-- Shipping progress read from CJ (worker/cj.js checkCjTracking).
alter table public.orders add column if not exists tracking_url text;
alter table public.orders add column if not exists supplier_status text;      -- CJ orderStatus, e.g. UNSHIPPED, SHIPPED
alter table public.orders add column if not exists supplier_checked_at timestamptz;
alter table public.orders add column if not exists shipped_at timestamptz;
alter table public.orders add column if not exists delivered_at timestamptz;
