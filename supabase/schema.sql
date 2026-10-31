-- SAKANVIP Supabase schema for product catalogue and per-user carts
create extension if not exists pgcrypto;
create table if not exists public.products (
 id uuid primary key default gen_random_uuid(), name text not null, category text not null,
 description text, price numeric(12,2) not null default 0 check (price >= 0),
 image_url text, active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.products enable row level security;
drop policy if exists "Anyone can view active products" on public.products;
create policy "Anyone can view active products" on public.products for select using (active = true);
create table if not exists public.cart_items (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 product_id uuid references public.products(id) on delete set null, product_name text not null,
 quantity integer not null check (quantity between 1 and 20), unit_price numeric(12,2) not null check (unit_price >= 0),
 size text, color text, created_at timestamptz not null default now()
);
create index if not exists cart_items_user_id_idx on public.cart_items(user_id);
alter table public.cart_items enable row level security;
drop policy if exists "Users manage their own cart" on public.cart_items;
create policy "Users manage their own cart" on public.cart_items for all to authenticated
 using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Manage catalogue writes only from a trusted admin environment. Never expose service_role in browser code.
