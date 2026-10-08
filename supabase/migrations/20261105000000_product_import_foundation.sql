-- ═══════════════════════════════════════════════════════════════════════════
-- Product import foundation (Stage 0): additive metadata, import tables, the
-- ownership gap on products, field locks, and the server-side import RPCs.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── Where the writes happen, and why ───────────────────────────────────────
--
-- The web app has never held the service-role key, and every guard that
-- decides who may sell (commercial_terms_write_guard, products_tier_guard,
-- the storage policies) treats a null auth.uid() — the service role — as
-- "server, let it through". An importer that wrote as the service role would
-- therefore bypass terms and plan checks. This one does not exist.
--
-- Every import write is a SECURITY DEFINER function called with the OWNER's
-- session:
--   · auth.uid() keeps its value inside a definer function, so the terms and
--     tier guards still fire exactly as they do for a hand-typed product;
--   · current_user becomes the function owner, so tg_is_server_write() is true
--     and the system-column trigger below lets the import set provenance
--     fields that a direct client write may not touch.
-- Imports always create DRAFTS. Publishing is an ordinary is_active = true
-- update by the owner, which the same triggers police.
--
-- ── What this migration changes on existing tables ─────────────────────────
-- Additive columns only. Two triggers on products and two on product_variants
-- are new behaviour:
--   · reserved / sold_at (and the new provenance columns) are no longer
--     client-writable. Nothing in either app writes them (searched both
--     repositories), checkout and reservation run through service-role RPCs.
--   · a client edit of an imported product's field locks that field against
--     later imports.
-- products_tier_guard is replaced with a copy that ignores a change confined
-- to the new lock bookkeeping, so a lapsed owner editing a variant is not
-- refused by the housekeeping that follows it.

-- ── 1. Connections (Stage 3 uses them; the table is created now) ──────────
create table if not exists public.shop_connections (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.local_businesses(id) on delete cascade,
  provider         text not null check (provider = any (array['shopify','woocommerce','square'])),
  external_account text not null check (length(external_account) between 1 and 300),
  display_name     text,
  status           text not null default 'pending'
                   check (status = any (array['pending','connected','paused','revoked','error'])),
  -- A NAME in the secret store, never the secret. Not readable by clients.
  credential_ref   text,
  scopes           text[] not null default '{}',
  last_sync_at     timestamptz,
  last_error       text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, provider, external_account)
);

create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.shop_connections(id) on delete cascade,
  business_id   uuid not null references public.local_businesses(id) on delete cascade,
  kind          text not null check (kind = any (array['full','incremental','webhook'])),
  status        text not null default 'running'
                check (status = any (array['running','succeeded','failed','partial'])),
  counts        jsonb not null default '{}'::jsonb,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- Webhook de-duplication. Server only: no client reads it.
create table if not exists public.shop_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid references public.shop_connections(id) on delete cascade,
  provider      text not null,
  event_id      text not null,
  topic         text,
  payload_hash  text,
  status        text not null default 'received'
                check (status = any (array['received','processed','ignored','failed'])),
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_id)
);

-- ── 2. Product metadata ───────────────────────────────────────────────────
alter table public.products
  add column if not exists sku                  text,
  add column if not exists external_source      text,
  add column if not exists external_ref         text,
  add column if not exists connection_id        uuid references public.shop_connections(id) on delete set null,
  add column if not exists source_hash          text,
  add column if not exists last_synced_at       timestamptz,
  add column if not exists sync_state           text not null default 'manual',
  add column if not exists source_locked_fields text[] not null default '{}';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_sync_state_check') then
    alter table public.products add constraint products_sync_state_check
      check (sync_state = any (array['manual','imported','synced']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_external_source_check') then
    alter table public.products add constraint products_external_source_check
      check (external_source is null or external_source = any (array['csv','shopify','woocommerce','square']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_external_ref_needs_source') then
    alter table public.products add constraint products_external_ref_needs_source
      check (external_ref is null or external_source is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_sku_len') then
    alter table public.products add constraint products_sku_len
      check (sku is null or length(sku) between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_external_ref_len') then
    alter table public.products add constraint products_external_ref_len
      check (external_ref is null or length(external_ref) between 1 and 200);
  end if;
end $$;

-- One product per (business, source, ref). A ref is only unique inside one
-- business and one source: two shops using the same ref never collide.
create unique index if not exists products_business_external_ref_uq
  on public.products (business_id, external_source, external_ref)
  where external_source is not null and external_ref is not null;

-- SKU is unique inside one business only. Never across businesses: a SKU is
-- the merchant's own label and says nothing about another merchant's product.
create unique index if not exists products_business_sku_uq
  on public.products (business_id, lower(sku))
  where sku is not null;

create index if not exists products_connection_idx on public.products (connection_id)
  where connection_id is not null;

alter table public.product_variants
  add column if not exists sku          text,
  add column if not exists external_ref text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'product_variants_sku_len') then
    alter table public.product_variants add constraint product_variants_sku_len
      check (sku is null or length(sku) between 1 and 100);
  end if;
end $$;

create unique index if not exists product_variants_product_external_ref_uq
  on public.product_variants (product_id, external_ref) where external_ref is not null;
create unique index if not exists product_variants_product_sku_uq
  on public.product_variants (product_id, lower(sku)) where sku is not null;

-- ── 3. Import batches and rows ────────────────────────────────────────────
create table if not exists public.import_batches (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.local_businesses(id) on delete cascade,
  created_by       uuid not null default auth.uid(),
  source           text not null default 'csv' check (source = any (array['csv'])),
  preset           text,
  filename         text,
  file_sha256      text,
  mapping          jsonb not null default '{}'::jsonb,
  options          jsonb not null default '{}'::jsonb,
  idempotency_key  text,
  status           text not null default 'queued'
                   check (status = any (array['queued','applying','complete','complete_with_errors','undone','cancelled'])),
  total_items      integer not null check (total_items between 1 and 500),
  counts           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  undo_expires_at  timestamptz not null default (now() + interval '7 days'),
  undone_at        timestamptz
);

create unique index if not exists import_batches_idem_uq
  on public.import_batches (business_id, idempotency_key) where idempotency_key is not null;
create index if not exists import_batches_business_idx
  on public.import_batches (business_id, created_at desc);

create table if not exists public.import_rows (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references public.import_batches(id) on delete cascade,
  business_id       uuid not null references public.local_businesses(id) on delete cascade,
  item_index        integer not null check (item_index >= 0),
  -- The CSV rows (1-based, header = row 1) this product item was built from.
  row_numbers       integer[] not null default '{}',
  action            text not null check (action = any (array['create','update','unchanged','skip','error'])),
  status            text not null default 'pending'
                    check (status = any (array['pending','applied','failed','skipped','undone'])),
  title             text,
  ext_ref           text,
  sku               text,
  target_product_id uuid,
  product_id        uuid references public.products(id) on delete set null,
  payload           jsonb not null default '{}'::jsonb,
  errors            jsonb not null default '[]'::jsonb,
  warnings          jsonb not null default '[]'::jsonb,
  before_snapshot   jsonb,
  result            jsonb,
  image_status      text not null default 'none'
                    check (image_status = any (array['none','pending','processing','done','partial','failed'])),
  image_claimed_at  timestamptz,
  image_results     jsonb,
  applied_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (batch_id, item_index)
);

create index if not exists import_rows_batch_status_idx on public.import_rows (batch_id, status, item_index);
create index if not exists import_rows_product_idx on public.import_rows (product_id) where product_id is not null;

-- ── 4. Row security: owner reads, nothing writes from a client ────────────
alter table public.shop_connections   enable row level security;
alter table public.sync_runs          enable row level security;
alter table public.shop_webhook_events enable row level security;
alter table public.import_batches     enable row level security;
alter table public.import_rows        enable row level security;

drop policy if exists "owner reads own shop connections" on public.shop_connections;
create policy "owner reads own shop connections" on public.shop_connections
  for select to authenticated
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "owner reads own sync runs" on public.sync_runs;
create policy "owner reads own sync runs" on public.sync_runs
  for select to authenticated
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "owner reads own import batches" on public.import_batches;
create policy "owner reads own import batches" on public.import_batches
  for select to authenticated
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "owner reads own import rows" on public.import_rows;
create policy "owner reads own import rows" on public.import_rows
  for select to authenticated
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));

-- Table privileges: Supabase's default privileges hand every public table to
-- anon and authenticated. Take it all back, then give the owner SELECT only.
revoke all on public.shop_connections, public.sync_runs, public.shop_webhook_events,
              public.import_batches, public.import_rows from anon, authenticated;
grant select (id, business_id, provider, external_account, display_name, status, scopes,
              last_sync_at, last_error, created_at, updated_at)
  on public.shop_connections to authenticated;           -- credential_ref stays server-only
grant select on public.sync_runs, public.import_batches, public.import_rows to authenticated;
grant all on public.shop_connections, public.sync_runs, public.shop_webhook_events,
             public.import_batches, public.import_rows to service_role;

-- ── 5. The ownership gap on products ──────────────────────────────────────
--
-- "owner manages products" is FOR ALL with a row predicate only, and
-- authenticated holds blanket table-level UPDATE, so before this a merchant
-- could set reserved or sold_at straight through the API. A client write may
-- no longer touch them, nor the provenance columns. tg_is_server_write() is
-- true for service-role RPCs (reserve/commit/release), SECURITY DEFINER
-- functions (the importer) and migrations, so none of those change.
--
-- It is SECURITY INVOKER on purpose: current_user must stay the role that is
-- actually writing.

create or replace function public.tg_products_system_columns()
  returns trigger
  language plpgsql
  set search_path = public
as $$
declare
  o         jsonb;
  n         jsonb;
  f         text;
  v_locks   text[];
  -- Fields a manual edit locks against later imports.
  lockable  constant text[] := array[
    'title','description','category','price_pence','compare_at_pence','stock_mode',
    'stock','lead_time_days','collect_only','free_uk_post','photos','sku'];
  -- Columns only the server may write.
  system_cols constant text[] := array[
    'reserved','sold_at','external_source','external_ref','connection_id',
    'source_hash','last_synced_at','sync_state'];
begin
  if public.tg_is_server_write() then
    return new;
  end if;

  n := to_jsonb(new);

  if tg_op = 'INSERT' then
    if new.reserved <> 0 or new.sold_at is not null
       or new.external_source is not null or new.external_ref is not null
       or new.connection_id is not null or new.source_hash is not null
       or new.last_synced_at is not null or new.sync_state <> 'manual'
       or cardinality(new.source_locked_fields) > 0 then
      raise exception 'Stock counters and import provenance are set by the platform, not by clients'
        using errcode = '42501';
    end if;
    return new;
  end if;

  o := to_jsonb(old);
  foreach f in array system_cols loop
    if (n -> f) is distinct from (o -> f) then
      raise exception 'Column % on products is maintained by the platform', f
        using errcode = '42501';
    end if;
  end loop;

  if new.source_locked_fields is distinct from old.source_locked_fields then
    raise exception 'Use the unlock action to release a locked field'
      using errcode = '42501';
  end if;

  if old.external_source is not null then
    if new.business_id is distinct from old.business_id then
      raise exception 'An imported product cannot be moved to another business'
        using errcode = '42501';
    end if;
    -- A manual edit of an imported field locks it, so the next import cannot
    -- overwrite what the merchant chose.
    v_locks := old.source_locked_fields;
    foreach f in array lockable loop
      if (n -> f) is distinct from (o -> f) and not (f = any (v_locks)) then
        v_locks := v_locks || f;
      end if;
    end loop;
    new.source_locked_fields := v_locks;
  end if;

  return new;
end;
$$;

comment on function public.tg_products_system_columns() is
  'Client writes may not set reserved, sold_at or import provenance, and a client edit of an imported product locks the edited fields against later imports. Server writes (service role, SECURITY DEFINER, migrations) pass untouched.';

drop trigger if exists products_system_columns on public.products;
create trigger products_system_columns
  before insert or update on public.products
  for each row execute function public.tg_products_system_columns();

-- Variants: reserved and the import ref are server-only; a client change to an
-- imported product's variants locks "variants" on the product.
create or replace function public._product_lock_variants(p_product uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  -- Called from tg_variants_system_columns, which is SECURITY INVOKER (it must
  -- see the real current_user), so authenticated needs EXECUTE. That makes it
  -- reachable as an RPC, hence the ownership check: it can only ever add the
  -- word "variants" to the lock list of a product the caller owns.
  if auth.uid() is null or not exists (
       select 1 from public.products p join public.local_businesses b on b.id = p.business_id
        where p.id = p_product and b.owner_id = auth.uid()) then
    return;
  end if;

  update public.products
     set source_locked_fields = array_append(source_locked_fields, 'variants')
   where id = p_product
     and external_source is not null
     and not ('variants' = any (source_locked_fields));
end;
$$;
revoke all on function public._product_lock_variants(uuid) from public, anon;
grant execute on function public._product_lock_variants(uuid) to authenticated;

create or replace function public.tg_variants_system_columns()
  returns trigger
  language plpgsql
  set search_path = public
as $$
declare v_product uuid;
begin
  if public.tg_is_server_write() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.reserved <> 0 or new.external_ref is not null then
      raise exception 'Variant stock counters and import references are set by the platform'
        using errcode = '42501';
    end if;
    v_product := new.product_id;
  elsif tg_op = 'UPDATE' then
    if new.reserved is distinct from old.reserved or new.external_ref is distinct from old.external_ref then
      raise exception 'Variant stock counters and import references are set by the platform'
        using errcode = '42501';
    end if;
    v_product := new.product_id;
  else
    v_product := old.product_id;
  end if;

  perform public._product_lock_variants(v_product);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists product_variants_system_columns on public.product_variants;
create trigger product_variants_system_columns
  before insert or update or delete on public.product_variants
  for each row execute function public.tg_variants_system_columns();

-- ── 6. products_tier_guard: ignore lock bookkeeping ───────────────────────
-- Identical to 20260919120000 except for the early return below.
create or replace function public.products_tier_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if new.is_active is not true then
    return new;
  end if;

  if TG_OP = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;

  -- Only the import lock bookkeeping moved: not a commercial change.
  if TG_OP = 'UPDATE'
     and (to_jsonb(new) - 'updated_at' - 'source_locked_fields')
       = (to_jsonb(old) - 'updated_at' - 'source_locked_fields') then
    return new;
  end if;

  if v_uid is null then
    return new;
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;
  end if;

  if not public.business_meets_tier(new.business_id, 'premium') then
    raise exception 'Selling needs a Premium plan. Your product is saved — publish it once your plan is active.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ── 7. Import RPCs ────────────────────────────────────────────────────────

create or replace function public._import_assert_owner(p_business uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to import products' using errcode = '42501';
  end if;
  if not exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid()) then
    raise exception 'You can only import products for a business you own' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public._import_assert_owner(uuid) from public, anon, authenticated;

-- Recomputes counts, and closes the batch once nothing is left to do.
create or replace function public._import_refresh_batch(p_batch uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_counts  jsonb;
  v_pending integer;
  v_images  integer;
  v_bad     integer;
begin
  select jsonb_build_object(
           'create',    count(*) filter (where action = 'create'),
           'update',    count(*) filter (where action = 'update'),
           'unchanged', count(*) filter (where action = 'unchanged'),
           'skip',      count(*) filter (where action = 'skip'),
           'error',     count(*) filter (where action = 'error'),
           'applied',   count(*) filter (where status = 'applied'),
           'failed',    count(*) filter (where status = 'failed'),
           'undone',    count(*) filter (where status = 'undone'),
           'images_pending', count(*) filter (where image_status in ('pending','processing')),
           'images_failed',  count(*) filter (where image_status in ('failed','partial'))),
         count(*) filter (where status = 'pending' and action in ('create','update')),
         count(*) filter (where image_status in ('pending','processing')),
         count(*) filter (where status = 'failed' or image_status in ('failed','partial'))
    into v_counts, v_pending, v_images, v_bad
    from public.import_rows where batch_id = p_batch;

  update public.import_batches
     set counts = v_counts
   where id = p_batch;

  if v_pending = 0 and v_images = 0 then
    update public.import_batches
       set status = case when v_bad > 0 then 'complete_with_errors' else 'complete' end,
           completed_at = coalesce(completed_at, now())
     where id = p_batch and status = 'applying';
  end if;
end;
$$;
revoke all on function public._import_refresh_batch(uuid) from public, anon, authenticated;

-- ── 7a. Create a batch (nothing is written to products) ──────────────────
create or replace function public.import_create_batch(
  p_business        uuid,
  p_source          text,
  p_preset          text,
  p_filename        text,
  p_file_sha256     text,
  p_mapping         jsonb,
  p_options         jsonb,
  p_total_items     integer,
  p_idempotency_key text
) returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform public._import_assert_owner(p_business);

  if p_source is distinct from 'csv' then
    raise exception 'Unsupported import source' using errcode = '22023';
  end if;
  if p_total_items is null or p_total_items < 1 or p_total_items > 500 then
    raise exception 'An import takes 1 to 500 products' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 100 then
    raise exception 'A retry key is required' using errcode = '22023';
  end if;

  -- The same key means the same confirm: return the batch it already made.
  select id into v_id from public.import_batches
   where business_id = p_business and idempotency_key = p_idempotency_key;
  if v_id is not null then
    return v_id;
  end if;

  -- Selling terms apply to drafts too: the same rule a hand-typed product has.
  if not public.business_may_transact(p_business, auth.uid()) then
    raise exception 'Accept the business & selling terms for this business before importing products'
      using errcode = '42501';
  end if;

  if exists (select 1 from public.import_batches
              where business_id = p_business and status in ('queued','applying')) then
    raise exception 'Another import for this business is still running'
      using errcode = '55006';
  end if;

  if (select count(*) from public.import_batches
       where business_id = p_business and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Too many imports today — try again tomorrow' using errcode = '54000';
  end if;

  insert into public.import_batches
    (business_id, source, preset, filename, file_sha256, mapping, options, idempotency_key, total_items)
  values
    (p_business, p_source, left(p_preset, 40), left(p_filename, 200), left(p_file_sha256, 64),
     coalesce(p_mapping, '{}'::jsonb), coalesce(p_options, '{}'::jsonb), p_idempotency_key, p_total_items)
  returning id into v_id;

  return v_id;
end;
$$;

-- ── 7b. Add planned items (idempotent by item_index) ──────────────────────
create or replace function public.import_add_rows(p_batch uuid, p_items jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  b      public.import_batches;
  it     jsonb;
  v_n    integer := 0;
  v_act  text;
  v_tgt  uuid;
  v_nrows integer;
begin
  select * into b from public.import_batches where id = p_batch;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(b.business_id);
  if b.status <> 'queued' then
    raise exception 'This import has already started' using errcode = '55006';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'Send at most 100 items at a time' using errcode = '22023';
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_act := it ->> 'action';
    if v_act is null or v_act <> all (array['create','update','unchanged','skip','error']) then
      raise exception 'Unknown action %', coalesce(v_act, '(none)') using errcode = '22023';
    end if;
    if (it ->> 'item_index')::integer >= b.total_items then
      raise exception 'Item index out of range' using errcode = '22023';
    end if;

    v_tgt := nullif(it ->> 'target_product_id', '')::uuid;
    if v_act in ('update', 'unchanged') then
      if v_tgt is null or not exists (
           select 1 from public.products where id = v_tgt and business_id = b.business_id) then
        raise exception 'An item targets a product that is not in this business' using errcode = '42501';
      end if;
    end if;
    if v_act in ('create', 'update') and jsonb_array_length(coalesce(it -> 'errors', '[]'::jsonb)) > 0 then
      raise exception 'An item with errors cannot be imported' using errcode = '22023';
    end if;

    insert into public.import_rows
      (batch_id, business_id, item_index, row_numbers, action, status, title, ext_ref, sku,
       target_product_id, payload, errors, warnings)
    values
      (p_batch, b.business_id, (it ->> 'item_index')::integer,
       coalesce((select array_agg(x::integer) from jsonb_array_elements_text(coalesce(it -> 'row_numbers', '[]'::jsonb)) x), '{}'),
       v_act,
       case when v_act in ('create', 'update') then 'pending' else 'skipped' end,
       left(it ->> 'title', 200), left(it ->> 'ext_ref', 200), left(it ->> 'sku', 100),
       v_tgt,
       coalesce(it -> 'payload', '{}'::jsonb),
       coalesce(it -> 'errors', '[]'::jsonb),
       coalesce(it -> 'warnings', '[]'::jsonb))
    on conflict (batch_id, item_index) do nothing;

    get diagnostics v_nrows = row_count;
    v_n := v_n + v_nrows;
  end loop;

  return v_n;
end;
$$;

-- ── 7c. Start applying (all items must have arrived) ──────────────────────
create or replace function public.import_start_batch(p_batch uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  b public.import_batches;
  v_have integer;
begin
  select * into b from public.import_batches where id = p_batch for update;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(b.business_id);

  if b.status = 'applying' then
    return jsonb_build_object('status', b.status);          -- a retry of the same call
  end if;
  if b.status <> 'queued' then
    raise exception 'This import cannot be started (%).', b.status using errcode = '55006';
  end if;

  select count(*) into v_have from public.import_rows where batch_id = p_batch;
  if v_have <> b.total_items then
    raise exception 'The plan is incomplete (% of % items received)', v_have, b.total_items
      using errcode = '22023';
  end if;

  update public.import_batches set status = 'applying', started_at = now() where id = p_batch;
  perform public._import_refresh_batch(p_batch);
  return jsonb_build_object('status', 'applying');
end;
$$;

-- ── 7d. Apply one product item (internal) ────────────────────────────────
create or replace function public._import_apply_item(p_row public.import_rows)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_f        jsonb := coalesce(p_row.payload -> 'fields', '{}'::jsonb);
  v_vars     jsonb := coalesce(p_row.payload -> 'variants', '[]'::jsonb);
  v_hash     text  := p_row.payload ->> 'source_hash';
  v_has_imgs boolean := jsonb_array_length(coalesce(p_row.payload -> 'image_urls', '[]'::jsonb)) > 0;
  p          public.products;
  v_pid      uuid;
  v_locks    text[];
  v_changes  jsonb := '{}'::jsonb;
  v_apply    jsonb := '{}'::jsonb;
  v_locked_skipped text[] := '{}';
  v_vcreated uuid[] := '{}';
  v_vupdated jsonb := '[]'::jsonb;
  k          text;
  v          jsonb;
  ev         public.product_variants;
  v_name     text;
  v_sku      text;
  v_vstock   integer;
  v_has_vars boolean;
  v_price    integer;
  v_pos      integer;
  fields     constant text[] := array[
    'title','description','category','price_pence','compare_at_pence','stock_mode',
    'stock','lead_time_days','collect_only','free_uk_post','sku'];
begin
  -- ── Variant arithmetic checked once, here and in the web validator ──
  if jsonb_array_length(v_vars) > 0 and (v_f ->> 'stock') is not null then
    raise exception 'A product with variants keeps its stock on the variants, not on the product';
  end if;
  if jsonb_array_length(v_vars) > 0 and (v_f ->> 'stock_mode') = 'one_off' then
    raise exception 'A one-off item cannot have variants';
  end if;

  if p_row.action = 'create' then
    v_price := (v_f ->> 'price_pence')::integer;
    insert into public.products
      (business_id, title, description, category, price_pence, compare_at_pence, stock_mode, stock,
       lead_time_days, collect_only, free_uk_post, is_active, photos,
       sku, external_source, external_ref, source_hash, last_synced_at, sync_state)
    values
      (p_row.business_id, v_f ->> 'title', nullif(v_f ->> 'description', ''), nullif(v_f ->> 'category', ''),
       v_price, (v_f ->> 'compare_at_pence')::integer,
       coalesce(v_f ->> 'stock_mode', 'tracked'), (v_f ->> 'stock')::integer,
       (v_f ->> 'lead_time_days')::integer,
       coalesce((v_f ->> 'collect_only')::boolean, false), coalesce((v_f ->> 'free_uk_post')::boolean, false),
       false, '{}',
       nullif(v_f ->> 'sku', ''), 'csv', nullif(p_row.ext_ref, ''), v_hash, now(), 'imported')
    returning id into v_pid;

    v_pos := 0;
    for v in select * from jsonb_array_elements(v_vars) loop
      if v_price + coalesce((v ->> 'price_delta_pence')::integer, 0) < 50 then
        raise exception 'Variant "%" would sell for less than £0.50', v ->> 'name';
      end if;
      insert into public.product_variants (product_id, name, price_delta_pence, stock, sku, external_ref, position, is_active)
      values (v_pid, v ->> 'name', coalesce((v ->> 'price_delta_pence')::integer, 0),
              (v ->> 'stock')::integer, nullif(v ->> 'sku', ''), nullif(v ->> 'sku', ''), v_pos, true);
      v_pos := v_pos + 1;
    end loop;

    return jsonb_build_object(
      'product_id', v_pid,
      'snapshot', jsonb_build_object('created', true),
      'result', jsonb_build_object('created', true, 'variants', jsonb_array_length(v_vars)));
  end if;

  -- ── update ──
  select * into p from public.products
   where id = p_row.target_product_id and business_id = p_row.business_id for update;
  if not found then
    raise exception 'The product this row updates no longer exists';
  end if;
  v_pid   := p.id;
  v_locks := p.source_locked_fields;

  foreach k in array fields loop
    if v_f ? k and (v_f -> k) is distinct from (to_jsonb(p) -> k) then
      if k = any (v_locks) then
        v_locked_skipped := v_locked_skipped || k;
      else
        v_apply   := v_apply || jsonb_build_object(k, v_f -> k);
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(p) -> k, 'to', v_f -> k));
      end if;
    end if;
  end loop;

  select exists (select 1 from public.product_variants where product_id = v_pid and is_active) or jsonb_array_length(v_vars) > 0
    into v_has_vars;
  if v_apply ? 'stock' and (v_apply ->> 'stock') is not null then
    if v_has_vars then
      raise exception 'This product has variants, so its stock is kept on the variants';
    end if;
    if (v_apply ->> 'stock')::integer < p.reserved then
      raise exception 'Stock of % is below the % currently held by open orders', v_apply ->> 'stock', p.reserved;
    end if;
  end if;
  if jsonb_array_length(v_vars) > 0 and p.stock is not null and not ('stock' = any (v_locks)) and not (v_apply ? 'stock') then
    raise exception 'This product has its own stock count; clear it before adding variants';
  end if;

  update public.products set
    title            = case when v_apply ? 'title'            then v_apply ->> 'title' else title end,
    description      = case when v_apply ? 'description'      then nullif(v_apply ->> 'description', '') else description end,
    category         = case when v_apply ? 'category'         then nullif(v_apply ->> 'category', '') else category end,
    price_pence      = case when v_apply ? 'price_pence'      then (v_apply ->> 'price_pence')::integer else price_pence end,
    compare_at_pence = case when v_apply ? 'compare_at_pence' then (v_apply ->> 'compare_at_pence')::integer else compare_at_pence end,
    stock_mode       = case when v_apply ? 'stock_mode'       then v_apply ->> 'stock_mode' else stock_mode end,
    stock            = case when v_apply ? 'stock'            then (v_apply ->> 'stock')::integer else stock end,
    lead_time_days   = case when v_apply ? 'lead_time_days'   then (v_apply ->> 'lead_time_days')::integer else lead_time_days end,
    collect_only     = case when v_apply ? 'collect_only'     then (v_apply ->> 'collect_only')::boolean else collect_only end,
    free_uk_post     = case when v_apply ? 'free_uk_post'     then (v_apply ->> 'free_uk_post')::boolean else free_uk_post end,
    sku              = case when v_apply ? 'sku'              then nullif(v_apply ->> 'sku', '') else sku end,
    external_source  = coalesce(external_source, 'csv'),
    external_ref     = coalesce(external_ref, nullif(p_row.ext_ref, '')),
    source_hash      = v_hash,
    last_synced_at   = now(),
    sync_state       = case when sync_state = 'manual' then 'imported' else sync_state end
  where id = v_pid;

  if jsonb_array_length(v_vars) > 0 then
    if 'variants' = any (v_locks) then
      v_locked_skipped := array_append(v_locked_skipped, 'variants');
    else
      select coalesce(max(position), -1) + 1 into v_pos from public.product_variants where product_id = v_pid;
      for v in select * from jsonb_array_elements(v_vars) loop
        v_name := v ->> 'name';
        v_sku  := nullif(v ->> 'sku', '');
        ev := null;
        if v_sku is not null then
          select * into ev from public.product_variants
           where product_id = v_pid and (lower(sku) = lower(v_sku) or external_ref = v_sku) limit 1;
        end if;
        if ev.id is null then
          select * into ev from public.product_variants
           where product_id = v_pid and lower(name) = lower(v_name) limit 1;
        end if;
        select price_pence into v_price from public.products where id = v_pid;
        if v_price + coalesce((v ->> 'price_delta_pence')::integer, 0) < 50 then
          raise exception 'Variant "%" would sell for less than £0.50', v_name;
        end if;
        v_vstock := (v ->> 'stock')::integer;
        if ev.id is null then
          insert into public.product_variants (product_id, name, price_delta_pence, stock, sku, external_ref, position, is_active)
          values (v_pid, v_name, coalesce((v ->> 'price_delta_pence')::integer, 0), v_vstock, v_sku, v_sku, v_pos, true)
          returning id into ev.id;
          v_vcreated := v_vcreated || ev.id;
          v_pos := v_pos + 1;
        else
          if v_vstock is not null and v_vstock < ev.reserved then
            raise exception 'Variant "%" stock of % is below the % held by open orders', v_name, v_vstock, ev.reserved;
          end if;
          v_vupdated := v_vupdated || jsonb_build_object(
            'id', ev.id,
            'from', jsonb_build_object('name', ev.name, 'price_delta_pence', ev.price_delta_pence, 'stock', ev.stock, 'sku', ev.sku),
            'to',   jsonb_build_object('name', v_name,
                                       'price_delta_pence', coalesce((v ->> 'price_delta_pence')::integer, ev.price_delta_pence),
                                       'stock', coalesce(v_vstock, ev.stock),
                                       'sku', coalesce(v_sku, ev.sku)));
          update public.product_variants set
            name = v_name,
            price_delta_pence = coalesce((v ->> 'price_delta_pence')::integer, price_delta_pence),
            stock = case when v ? 'stock' then v_vstock else stock end,
            sku = coalesce(v_sku, sku),
            external_ref = coalesce(external_ref, v_sku)
          where id = ev.id;
        end if;
      end loop;
    end if;
  end if;

  return jsonb_build_object(
    'product_id', v_pid,
    'snapshot', jsonb_build_object(
      'fields', v_changes, 'variants_created', to_jsonb(v_vcreated), 'variants_updated', v_vupdated,
      'locked_skipped', to_jsonb(v_locked_skipped)),
    'result', jsonb_build_object(
      'updated', true, 'changed_fields', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_object_keys(v_changes) key),
      'locked_skipped', to_jsonb(v_locked_skipped)));
end;
$$;
revoke all on function public._import_apply_item(public.import_rows) from public, anon, authenticated;

-- ── 7e. Apply the next chunk ─────────────────────────────────────────────
create or replace function public.import_apply_next(p_batch uuid, p_limit integer default 25)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  b        public.import_batches;
  r        public.import_rows;
  v_out    jsonb;
  v_ok     integer := 0;
  v_fail   integer := 0;
  v_left   integer;
  v_msg    text;
begin
  select * into b from public.import_batches where id = p_batch;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(b.business_id);
  if b.status <> 'applying' then
    raise exception 'This import is not running (%).', b.status using errcode = '55006';
  end if;

  p_limit := least(greatest(coalesce(p_limit, 25), 1), 50);

  for r in
    select * from public.import_rows
     where batch_id = p_batch and status = 'pending' and action in ('create', 'update')
     order by item_index
     limit p_limit
     for update skip locked
  loop
    begin
      v_out := public._import_apply_item(r);
      update public.import_rows set
        status = 'applied',
        product_id = (v_out ->> 'product_id')::uuid,
        before_snapshot = v_out -> 'snapshot',
        result = v_out -> 'result',
        applied_at = now(),
        image_status = case when jsonb_array_length(coalesce(payload -> 'image_urls', '[]'::jsonb)) > 0 then 'pending' else 'none' end
      where id = r.id;
      v_ok := v_ok + 1;
    exception when others then
      v_msg := case
        when sqlstate = '23505' and sqlerrm like '%products_business_external_ref_uq%'
          then 'Another product in this shop already uses that ref'
        when sqlstate = '23505' and sqlerrm like '%products_business_sku_uq%'
          then 'Another product in this shop already uses that SKU'
        when sqlstate = '23514' and sqlerrm like '%price_pence%'
          then 'Price must be at least £0.50'
        when sqlstate = '23514' and sqlerrm like '%compare_at%'
          then 'Compare-at price must be higher than the price'
        else sqlerrm end;
      update public.import_rows set
        status = 'failed',
        errors = errors || jsonb_build_array(jsonb_build_object('message', v_msg, 'sqlstate', sqlstate))
      where id = r.id;
      v_fail := v_fail + 1;
    end;
  end loop;

  perform public._import_refresh_batch(p_batch);

  select count(*) into v_left from public.import_rows
   where batch_id = p_batch and status = 'pending' and action in ('create', 'update');

  return jsonb_build_object('applied', v_ok, 'failed', v_fail, 'remaining', v_left,
                            'status', (select status from public.import_batches where id = p_batch));
end;
$$;

-- ── 7f. Image hand-off ───────────────────────────────────────────────────
create or replace function public.import_claim_image_row(p_batch uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  b public.import_batches;
  r public.import_rows;
  p public.products;
begin
  select * into b from public.import_batches where id = p_batch;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(b.business_id);

  loop
    select * into r from public.import_rows
     where batch_id = p_batch and status = 'applied'
       and (image_status = 'pending'
            or (image_status = 'processing' and image_claimed_at < now() - interval '90 seconds'))
     order by item_index
     limit 1
     for update skip locked;
    if not found then
      perform public._import_refresh_batch(p_batch);
      return null;
    end if;

    select * into p from public.products where id = r.product_id;
    if not found or 'photos' = any (p.source_locked_fields) then
      update public.import_rows set image_status = 'done',
             image_results = jsonb_build_object('skipped', case when found then 'photos are locked' else 'product removed' end)
       where id = r.id;
      continue;
    end if;

    update public.import_rows set image_status = 'processing', image_claimed_at = now() where id = r.id;
    return jsonb_build_object(
      'row_id', r.id, 'product_id', p.id, 'business_id', p.business_id,
      'urls', coalesce(r.payload -> 'image_urls', '[]'::jsonb),
      'existing_photos', to_jsonb(p.photos));
  end loop;
end;
$$;

create or replace function public.import_set_row_images(p_row uuid, p_photos text[], p_results jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  r        public.import_rows;
  p        public.products;
  v_prefix text;
  u        text;
  v_new    text[] := '{}';
  v_all    text[];
  v_ok     integer;
  v_bad    integer;
  v_status text;
begin
  select * into r from public.import_rows where id = p_row for update;
  if not found then raise exception 'Import row not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(r.business_id);
  if r.status <> 'applied' then raise exception 'That row was not imported' using errcode = '55006'; end if;

  select * into p from public.products where id = r.product_id for update;
  if not found then raise exception 'The product no longer exists' using errcode = 'P0002'; end if;
  if 'photos' = any (p.source_locked_fields) then
    update public.import_rows set image_status = 'done', image_results = jsonb_build_object('skipped', 'photos are locked') where id = r.id;
    perform public._import_refresh_batch(r.batch_id);
    return jsonb_build_object('status', 'done', 'added', 0);
  end if;

  -- Only files already re-hosted under THIS business's folder in business-media.
  v_prefix := '/storage/v1/object/public/business-media/' || r.business_id::text || '/';
  foreach u in array coalesce(p_photos, '{}') loop
    if u like 'https://%' and position(v_prefix in u) > 0 and u not like '%..%' and not (u = any (p.photos)) and not (u = any (v_new)) then
      v_new := v_new || u;
    elsif not (u like 'https://%' and position(v_prefix in u) > 0) then
      raise exception 'Photos must be stored in your own business-media folder' using errcode = '42501';
    end if;
  end loop;

  v_all := p.photos || v_new;
  if cardinality(v_all) > 5 then
    v_new := v_new[1: greatest(0, 5 - cardinality(p.photos))];
    v_all := p.photos || v_new;
  end if;

  update public.products set photos = v_all, last_synced_at = now() where id = p.id;

  select count(*) filter (where (e ->> 'ok')::boolean), count(*) filter (where not (e ->> 'ok')::boolean)
    into v_ok, v_bad
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e;
  v_status := case when v_bad = 0 then 'done' when v_ok = 0 then 'failed' else 'partial' end;

  update public.import_rows set
    image_status = v_status,
    image_results = coalesce(p_results, '[]'::jsonb),
    before_snapshot = jsonb_set(coalesce(before_snapshot, '{}'::jsonb), '{photos_added}', to_jsonb(v_new))
  where id = r.id;

  perform public._import_refresh_batch(r.batch_id);
  return jsonb_build_object('status', v_status, 'added', cardinality(v_new));
end;
$$;

-- ── 7g. Cancel before anything is written ────────────────────────────────
create or replace function public.import_cancel_batch(p_batch uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare b public.import_batches;
begin
  select * into b from public.import_batches where id = p_batch for update;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(b.business_id);
  if b.status = 'cancelled' then return; end if;
  if b.status <> 'queued' then
    raise exception 'Only an import that has not started can be cancelled — use Undo after it finishes'
      using errcode = '55006';
  end if;
  update public.import_batches set status = 'cancelled', completed_at = now() where id = p_batch;
end;
$$;

-- ── 7h. Undo (all or nothing) ────────────────────────────────────────────
create or replace function public.import_undo_batch(p_batch uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  b          public.import_batches;
  r          public.import_rows;
  p          public.products;
  v_blockers jsonb := '[]'::jsonb;
  v_reason   text;
  v_deleted  integer := 0;
  v_reverted integer := 0;
  v_kept     integer := 0;
  v_paths    text[] := '{}';
  v_marker   constant text := '/storage/v1/object/public/business-media/';
  ph         text;
  k          text;
  ch         jsonb;
  vu         jsonb;
  cur        jsonb;
begin
  select * into b from public.import_batches where id = p_batch for update;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(b.business_id);

  if b.status = 'undone' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if b.status not in ('complete', 'complete_with_errors') then
    raise exception 'Only a finished import can be undone' using errcode = '55006';
  end if;
  if now() > b.undo_expires_at then
    raise exception 'The 7-day undo window for this import has ended' using errcode = '55006';
  end if;

  -- Pass 1: find anything that makes undo unsafe. Nothing is changed here.
  for r in select * from public.import_rows
            where batch_id = p_batch and status = 'applied' and action = 'create' loop
    select * into p from public.products where id = r.product_id;
    if not found then continue; end if;
    v_reason := null;
    if p.is_active then
      v_reason := 'it has been published — withdraw it first';
    elsif p.reserved > 0 or p.sold_at is not null
       or exists (select 1 from public.product_variants where product_id = p.id and reserved > 0) then
      v_reason := 'it has stock held by an order';
    elsif exists (select 1 from public.product_order_items where product_id = p.id) then
      v_reason := 'it appears on an order';
    elsif cardinality(p.source_locked_fields) > 0 then
      v_reason := 'you have edited it since the import';
    end if;
    if v_reason is not null then
      v_blockers := v_blockers || jsonb_build_object('product_id', p.id, 'title', p.title, 'reason', v_reason);
    end if;
  end loop;

  if jsonb_array_length(v_blockers) > 0 then
    return jsonb_build_object('ok', false, 'blockers', v_blockers);
  end if;

  -- Pass 2: do it.
  for r in select * from public.import_rows where batch_id = p_batch and status = 'applied' order by item_index loop
    select * into p from public.products where id = r.product_id for update;
    if found then
      if r.action = 'create' then
        foreach ph in array p.photos loop
          if position(v_marker in ph) > 0 then
            v_paths := v_paths || split_part(ph, v_marker, 2);
          end if;
        end loop;
        delete from public.products where id = p.id;
        v_deleted := v_deleted + 1;
      else
        -- Revert a field only where it still holds the value the import wrote.
        cur := to_jsonb(p);
        for k, ch in select * from jsonb_each(coalesce(r.before_snapshot -> 'fields', '{}'::jsonb)) loop
          if (cur -> k) is not distinct from (ch -> 'to') then
            execute format('update public.products set %I = (jsonb_populate_record(null::public.products, $1)).%I where id = $2', k, k)
              using jsonb_build_object(k, ch -> 'from'), p.id;
            v_reverted := v_reverted + 1;
          else
            v_kept := v_kept + 1;
          end if;
        end loop;
        -- Variants the import added go, if no order has touched them.
        delete from public.product_variants pv
         where pv.product_id = p.id
           and pv.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(r.before_snapshot -> 'variants_created', '[]'::jsonb)) x)
           and pv.reserved = 0
           and not exists (select 1 from public.product_order_items i where i.variant_id = pv.id);
        for vu in select * from jsonb_array_elements(coalesce(r.before_snapshot -> 'variants_updated', '[]'::jsonb)) loop
          update public.product_variants set
            name = vu -> 'from' ->> 'name',
            price_delta_pence = (vu -> 'from' ->> 'price_delta_pence')::integer,
            stock = (vu -> 'from' ->> 'stock')::integer,
            sku = vu -> 'from' ->> 'sku'
          where id = (vu ->> 'id')::uuid
            and name = vu -> 'to' ->> 'name'
            and price_delta_pence = (vu -> 'to' ->> 'price_delta_pence')::integer
            and stock is not distinct from (vu -> 'to' ->> 'stock')::integer;
        end loop;
        -- Photos the import added.
        if r.before_snapshot ? 'photos_added' then
          update public.products set photos = array(
            select x from unnest(photos) x
             where x <> all (array(select jsonb_array_elements_text(r.before_snapshot -> 'photos_added'))))
           where id = p.id and not ('photos' = any (source_locked_fields));
          for ph in select jsonb_array_elements_text(r.before_snapshot -> 'photos_added') loop
            if position(v_marker in ph) > 0 then v_paths := v_paths || split_part(ph, v_marker, 2); end if;
          end loop;
        end if;
      end if;
    end if;
    update public.import_rows set status = 'undone' where id = r.id;
  end loop;

  update public.import_batches set status = 'undone', undone_at = now() where id = p_batch;
  perform public._import_refresh_batch(p_batch);

  return jsonb_build_object('ok', true, 'deleted', v_deleted, 'reverted_fields', v_reverted,
                            'kept_edited_fields', v_kept, 'storage_paths', to_jsonb(v_paths));
end;
$$;

-- ── 7i. Release a field lock ─────────────────────────────────────────────
create or replace function public.product_unlock_fields(p_product uuid, p_fields text[] default null)
  returns text[]
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  p public.products;
  v_new text[];
begin
  select * into p from public.products where id = p_product for update;
  if not found then raise exception 'Product not found' using errcode = 'P0002'; end if;
  perform public._import_assert_owner(p.business_id);

  v_new := case when p_fields is null or cardinality(p_fields) = 0 then '{}'
                else array(select x from unnest(p.source_locked_fields) x where x <> all (p_fields)) end;
  update public.products set source_locked_fields = v_new where id = p_product;
  return v_new;
end;
$$;

-- Callable by signed-in owners only. The public pseudo-role is stripped first,
-- because functions are executable by PUBLIC (and so by anon) by default.
revoke all on function
  public.import_create_batch(uuid, text, text, text, text, jsonb, jsonb, integer, text),
  public.import_add_rows(uuid, jsonb),
  public.import_start_batch(uuid),
  public.import_apply_next(uuid, integer),
  public.import_claim_image_row(uuid),
  public.import_set_row_images(uuid, text[], jsonb),
  public.import_cancel_batch(uuid),
  public.import_undo_batch(uuid),
  public.product_unlock_fields(uuid, text[])
  from public, anon;
grant execute on function
  public.import_create_batch(uuid, text, text, text, text, jsonb, jsonb, integer, text),
  public.import_add_rows(uuid, jsonb),
  public.import_start_batch(uuid),
  public.import_apply_next(uuid, integer),
  public.import_claim_image_row(uuid),
  public.import_set_row_images(uuid, text[], jsonb),
  public.import_cancel_batch(uuid),
  public.import_undo_batch(uuid),
  public.product_unlock_fields(uuid, text[])
  to authenticated;
