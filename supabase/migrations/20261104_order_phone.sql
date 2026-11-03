-- Delivery phone from the checkout form (CJ and the carriers require one).
alter table public.orders add column if not exists customer_phone text;
