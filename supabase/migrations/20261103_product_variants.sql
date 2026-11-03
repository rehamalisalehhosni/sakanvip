-- Real CJ variants per product (one row per CJ vid). The page reads active rows to offer only sizes and
-- colours that exist; checkout takes the variant's price and CJ vid from here, never from the browser.
create table if not exists public.product_variants (
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references public.products(id) on delete cascade,
 cj_vid text not null unique,
 sku text,
 options jsonb not null default '{}'::jsonb, -- e.g. {"Color": "Sky blue", "Size": "M"}, keys in products.variant_dims order
 size text, color text,                      -- for invoices and order emails
 supplier_price numeric(12,2),
 price numeric(12,2) not null check (price >= 0),
 image_url text, weight_g integer,
 active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists product_variants_product_id_idx on public.product_variants(product_id);
alter table public.product_variants enable row level security;
drop policy if exists "Anyone can view active variants" on public.product_variants;
create policy "Anyone can view active variants" on public.product_variants for select using (active = true);
revoke insert, update, delete on public.product_variants from anon, authenticated;

-- Dimension names in display order, e.g. {Color,Size}.
alter table public.products add column if not exists variant_dims text[];
-- The chosen variant in a saved cart.
alter table public.cart_items add column if not exists variant_id uuid references public.product_variants(id) on delete set null;
