-- CJ's total for the order (product, shipping, import VAT) in USD, read before paying it.
alter table public.orders add column if not exists supplier_cost_usd numeric(12,2);
