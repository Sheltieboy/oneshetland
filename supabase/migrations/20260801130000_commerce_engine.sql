-- ────────────────────────────────────────────────────────────────────────────
-- Shop Shetland — commerce engine, Phase 1.
--
-- Products live on the business's listing ("sell where Shetland already is",
-- not a standalone webshop builder). Included in the Premium plan; the
-- platform takes 5% via the existing `product` commission rail (set below).
--
--   products / product_variants  — catalogue. Three stock modes, no SKU
--                                  jargon: tracked | made_to_order | one_off.
--   business_shipping            — ONE fulfilment config per business
--                                  (collect / post rate card; fetch column
--                                  ready for the Phase-2 lane).
--   product_orders / _items      — orders with snapshot pricing. Stock is
--                                  RESERVED at intent time (reserved cols),
--                                  committed on payment, released on expiry.
--
-- Orders are written only by edge functions (service role); buyers read their
-- own, business owners read/update theirs, admins everything.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.products (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.local_businesses(id) on delete cascade,
  title            text not null check (length(trim(title)) between 1 and 200),
  description      text,
  category         text check (category is null or category = any (array[
                     'knitwear','craft','art','food_drink','home','beauty','outdoor','books_music','other'])),
  price_pence      integer not null check (price_pence >= 50),
  compare_at_pence integer check (compare_at_pence is null or compare_at_pence > price_pence),
  photos           text[] not null default '{}',
  stock_mode       text not null default 'tracked'
                   check (stock_mode = any (array['tracked','made_to_order','one_off'])),
  stock            integer check (stock is null or stock >= 0),
  reserved         integer not null default 0 check (reserved >= 0),
  lead_time_days   integer check (lead_time_days is null or lead_time_days between 1 and 90),
  collect_only     boolean not null default false,
  free_uk_post     boolean not null default false,
  is_active        boolean not null default true,
  sold_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.product_variants (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products(id) on delete cascade,
  name              text not null check (length(trim(name)) between 1 and 80), -- "Small · Navy"
  price_delta_pence integer not null default 0,
  stock             integer check (stock is null or stock >= 0),
  reserved          integer not null default 0 check (reserved >= 0),
  position          integer not null default 0,
  is_active         boolean not null default true
);

create table if not exists public.business_shipping (
  business_id               uuid primary key references public.local_businesses(id) on delete cascade,
  collect_enabled           boolean not null default true,
  collect_note              text,
  post_enabled              boolean not null default false,
  post_shetland_pence       integer check (post_shetland_pence is null or post_shetland_pence >= 0),
  post_uk_pence             integer check (post_uk_pence is null or post_uk_pence >= 0),
  post_per_extra_item_pence integer not null default 0 check (post_per_extra_item_pence >= 0),
  free_over_pence           integer check (free_over_pence is null or free_over_pence > 0),
  fetch_enabled             boolean not null default false, -- Phase 2 lane
  vat_registered            boolean not null default false,
  updated_at                timestamptz not null default now()
);

create table if not exists public.product_orders (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.local_businesses(id) on delete restrict,
  buyer_id            uuid not null,
  status              text not null default 'pending' check (status = any (array[
                        'pending','paid','accepted','ready','handed_over','posted',
                        'completed','cancelled','refunded','expired'])),
  fulfilment          text not null check (fulfilment = any (array['collect','post','fetch'])),
  items_pence         integer not null check (items_pence >= 0),
  shipping_pence      integer not null default 0 check (shipping_pence >= 0),
  total_pence         integer not null check (total_pence >= 0),
  commission_pence    integer not null default 0 check (commission_pence >= 0),
  paid_via            text check (paid_via is null or paid_via = any (array['card','wallet'])),
  payment_intent_id   text,
  delivery_name       text,
  delivery_address    text,
  delivery_postcode   text,
  contact_phone       text,
  buyer_note          text,
  tracking_ref        text,
  delivery_request_id uuid, -- Fetch lane (Phase 2)
  expires_at          timestamptz, -- pending-payment TTL; reminder-runner expires
  paid_at             timestamptz,
  accepted_at         timestamptz,
  ready_at            timestamptz,
  posted_at           timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.product_order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.product_orders(id) on delete cascade,
  product_id   uuid references public.products(id) on delete set null,
  variant_id   uuid references public.product_variants(id) on delete set null,
  -- Snapshots: the receipt stays true even if the product is edited/deleted.
  title        text not null,
  variant_name text,
  unit_pence   integer not null check (unit_pence >= 0),
  qty          integer not null check (qty between 1 and 99),
  photo_url    text
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists products_business_idx on public.products (business_id, is_active);
create index if not exists products_browse_idx   on public.products (is_active, category, created_at desc);
create index if not exists product_orders_business_idx on public.product_orders (business_id, status, created_at desc);
create index if not exists product_orders_buyer_idx    on public.product_orders (buyer_id, created_at desc);
create index if not exists product_orders_pending_idx  on public.product_orders (status, expires_at) where status = 'pending';

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();
drop trigger if exists business_shipping_updated_at on public.business_shipping;
create trigger business_shipping_updated_at before update on public.business_shipping
  for each row execute function public.set_updated_at();
drop trigger if exists product_orders_updated_at on public.product_orders;
create trigger product_orders_updated_at before update on public.product_orders
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.products            enable row level security;
alter table public.product_variants    enable row level security;
alter table public.business_shipping   enable row level security;
alter table public.product_orders      enable row level security;
alter table public.product_order_items enable row level security;

-- Anyone can browse live products of active businesses.
drop policy if exists "public reads live products" on public.products;
create policy "public reads live products" on public.products
  for select using (
    is_active and exists (
      select 1 from public.local_businesses b
      where b.id = business_id and b.is_active
    )
  );

-- The business owner manages their own catalogue.
drop policy if exists "owner manages products" on public.products;
create policy "owner manages products" on public.products
  for all
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()))
  with check (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "public reads live variants" on public.product_variants;
create policy "public reads live variants" on public.product_variants
  for select using (
    is_active and exists (select 1 from public.products p where p.id = product_id and p.is_active)
  );

drop policy if exists "owner manages variants" on public.product_variants;
create policy "owner manages variants" on public.product_variants
  for all
  using (exists (
    select 1 from public.products p join public.local_businesses b on b.id = p.business_id
    where p.id = product_id and b.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.products p join public.local_businesses b on b.id = p.business_id
    where p.id = product_id and b.owner_id = auth.uid()));

-- Rate card is public (checkout needs it) and owner-writable.
drop policy if exists "public reads shipping" on public.business_shipping;
create policy "public reads shipping" on public.business_shipping
  for select using (true);

drop policy if exists "owner manages shipping" on public.business_shipping;
create policy "owner manages shipping" on public.business_shipping
  for all
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()))
  with check (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

-- Orders: written ONLY by edge functions (service role). Buyers see their own;
-- the business sees and progresses theirs (status/tracking via UPDATE).
drop policy if exists "buyer reads own orders" on public.product_orders;
create policy "buyer reads own orders" on public.product_orders
  for select using (buyer_id = auth.uid());

drop policy if exists "business reads its orders" on public.product_orders;
create policy "business reads its orders" on public.product_orders
  for select using (exists (
    select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "business updates its orders" on public.product_orders;
create policy "business updates its orders" on public.product_orders
  for update using (exists (
    select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "order items follow order" on public.product_order_items;
create policy "order items follow order" on public.product_order_items
  for select using (exists (
    select 1 from public.product_orders o
    where o.id = order_id and (
      o.buyer_id = auth.uid()
      or exists (select 1 from public.local_businesses b where b.id = o.business_id and b.owner_id = auth.uid())
    )));

-- Admins see and manage everything.
drop policy if exists "admins manage products" on public.products;
create policy "admins manage products" on public.products
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "admins manage product orders" on public.product_orders;
create policy "admins manage product orders" on public.product_orders
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ── Commission: the product rail earns 5% (owner decision, Aug 2026 —
--    justified by active marketing of shops via Peerie Press + homepage). ──
insert into public.admin_config (key, value, category, description) values
  ('fees.product.percent_bps', '500', 'fees', 'Product sales commission, basis points (500 = 5%)'),
  ('fees.product.fixed_pence', '0',   'fees', 'Product sales fixed fee per order, pence')
on conflict (key) do update set value = excluded.value;
