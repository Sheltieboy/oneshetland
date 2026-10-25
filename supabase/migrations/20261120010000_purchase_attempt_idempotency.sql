-- ═══════════════════════════════════════════════════════════════════════════
-- One purchase attempt, one order / gift — enforced by the database, not by a button
-- ═══════════════════════════════════════════════════════════════════════════
--
-- create-product-order-intent and create-gift-intent each minted a NEW row id on every call and then keyed the Stripe
-- PaymentIntent (and the wallet debit) on that fresh id — `product-order-${order.id}`, `gift-${gift.id}`, `gift:${gift.id}`.
-- A key that is different on every call can never recognise a repeat. So a double-click, a retried request after a lost
-- response, two tabs, or a replayed API call each produced another order (and another stock reservation, or another gift),
-- another PaymentIntent and — on the wallet routes — another debit. The gift PaymentSheet route had no Stripe key at all.
--
-- Event tickets, pass purchases, memberships, donations and boosts already solved this with a checkout attempt id from the
-- client (`client_request_id`) that the server keys on. Shop orders and gifts were the two that did not. This brings them in
-- line, using the same shape the ticket flow proved:
--
--   · a nullable client_request_id, UNIQUE per buyer where present, so the 7 historical orders / gifts (which predate it) stay
--     honestly null and cannot collide with each other;
--   · an atomic claim-or-replay function: the first call creates the row, every later call with the same (buyer, id) resolves to
--     THAT row — including a call that loses a race and was waiting on the winner's uncommitted insert;
--   · a reused id for a DIFFERENT basket, item, recipient or payment method is refused, never silently swapped;
--   · a cancelled / expired attempt is reported as such, so the client starts a new one — it is never resurrected;
--   · the stock reservation is made INSIDE the claim, in the same transaction as the order row, so a sold-out line rolls the
--     whole thing back and a repeat can never reserve twice;
--   · the stock release for a cancelled order is one status-guarded flip, so it happens once however many callers race.
--
-- Because the row is now stable per attempt, the Stripe idempotency key and the wallet idempotency key that were already
-- derived from the row id become correct without being changed.
--
-- A short LEASE (processing_claimed_at) makes the money-moving step single-flight: whoever holds it creates the PaymentIntent
-- or runs the wallet debit; a concurrent repeat is told "already being processed" and moves nothing. The lease expires after
-- 90 seconds so a crashed request cannot lock an attempt, and the Stripe/wallet keys make a takeover safe.
--
-- Finally, a payment can belong to at most ONE order and ONE gift: unique indexes on payment_intent_id (production has no
-- duplicates — checked read-only before this was written).
--
-- Nothing here is reachable by anon or authenticated: the functions are SECURITY DEFINER and service_role-only, and neither
-- table has an INSERT policy for clients.

begin;

-- ── product_orders ──────────────────────────────────────────────────────────
alter table public.product_orders
  add column if not exists client_request_id    text,
  add column if not exists pay_mode             text,
  add column if not exists processing_claimed_at timestamptz;

alter table public.product_orders drop constraint if exists product_orders_client_request_id_len;
alter table public.product_orders add  constraint product_orders_client_request_id_len
  check (client_request_id is null or char_length(client_request_id) between 8 and 100);
alter table public.product_orders drop constraint if exists product_orders_pay_mode_check;
alter table public.product_orders add  constraint product_orders_pay_mode_check
  check (pay_mode is null or pay_mode in ('wallet', 'card_form', 'card_saved'));

create unique index if not exists product_orders_buyer_request_key
  on public.product_orders (buyer_id, client_request_id) where client_request_id is not null;
create unique index if not exists product_orders_payment_intent_key
  on public.product_orders (payment_intent_id) where payment_intent_id is not null;

comment on column public.product_orders.client_request_id is
  'One id per deliberate checkout, minted by the client at the checkout boundary. UNIQUE per buyer. An idempotency token ONLY: the basket, price and destination are always resolved server-side.';
comment on column public.product_orders.pay_mode is
  'How this attempt pays: wallet | card_form | card_saved. Fixed when the attempt is claimed; a repeat that asks for a different method is refused rather than starting a second payment.';
comment on column public.product_orders.processing_claimed_at is
  'Lease: set while one request is creating the PaymentIntent / running the wallet debit for this order. Stale after 90 s.';

-- ── book_gifts ──────────────────────────────────────────────────────────────
alter table public.book_gifts
  add column if not exists client_request_id    text,
  add column if not exists pay_mode             text,
  add column if not exists processing_claimed_at timestamptz;

alter table public.book_gifts drop constraint if exists book_gifts_client_request_id_len;
alter table public.book_gifts add  constraint book_gifts_client_request_id_len
  check (client_request_id is null or char_length(client_request_id) between 8 and 100);
alter table public.book_gifts drop constraint if exists book_gifts_pay_mode_check;
alter table public.book_gifts add  constraint book_gifts_pay_mode_check
  check (pay_mode is null or pay_mode in ('wallet', 'card_form', 'card_saved'));

create unique index if not exists book_gifts_purchaser_request_key
  on public.book_gifts (purchaser_id, client_request_id) where client_request_id is not null;
create unique index if not exists book_gifts_payment_intent_key
  on public.book_gifts (payment_intent_id) where payment_intent_id is not null;

comment on column public.book_gifts.client_request_id is
  'One id per deliberate gift purchase, minted by the client. UNIQUE per purchaser. Idempotency token only.';

-- ── claim_product_order ─────────────────────────────────────────────────────
-- Claim the attempt, or resolve a repeat to the order it already created. Returns jsonb:
--   { order_id, replayed, status, pay_mode, payment_intent_id, total_pence }
-- Raises (and changes nothing) for: bad input (22023), SOLD_OUT, IDEMPOTENCY_CONFLICT.
-- An attempt that is already cancelled / expired is RETURNED with that status (not raised), so the expiry flip it performs
-- is committed rather than rolled back.
create or replace function public.claim_product_order(
  p_buyer               uuid,
  p_client_request_id   text,
  p_pay_mode            text,
  p_business            uuid,
  p_fulfilment          text,
  p_items               jsonb,
  p_items_pence         integer,
  p_shipping_pence      integer,
  p_total_pence         integer,
  p_commission_pence    integer,
  p_delivery_name       text,
  p_delivery_address    text,
  p_delivery_postcode   text,
  p_delivery_region     text,
  p_contact_phone       text,
  p_buyer_note          text,
  p_ttl_minutes         integer default 30
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order   public.product_orders;
  v_id      uuid;
  v_line    jsonb;
  v_ok      boolean;
  v_diff    integer;
  v_n       integer;
begin
  if p_buyer is null or p_business is null then
    raise exception 'claim_product_order: buyer and business are required' using errcode = '22023';
  end if;
  if p_client_request_id is null or char_length(p_client_request_id) < 8 or char_length(p_client_request_id) > 100 then
    raise exception 'claim_product_order: client_request_id must be 8-100 characters' using errcode = '22023';
  end if;
  if p_pay_mode is null or p_pay_mode not in ('wallet', 'card_form', 'card_saved') then
    raise exception 'claim_product_order: bad pay_mode' using errcode = '22023';
  end if;
  if p_fulfilment is null or p_fulfilment not in ('collect', 'post', 'fetch') then
    raise exception 'claim_product_order: bad fulfilment' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'claim_product_order: items must be an array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 20 then
    raise exception 'claim_product_order: a basket has 1-20 lines' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) x
     where (x->>'product_id') is null or (x->>'qty') is null
        or (x->>'qty')::int < 1 or (x->>'qty')::int > 99
        or (x->>'unit_pence') is null or (x->>'unit_pence')::int < 0
        or (x->>'title') is null
  ) then
    raise exception 'claim_product_order: every line needs a product, a quantity, a price and a title' using errcode = '22023';
  end if;
  if p_items_pence is null or p_shipping_pence is null or p_total_pence is null or p_commission_pence is null
     or p_items_pence < 0 or p_shipping_pence < 0 or p_total_pence < 0 or p_commission_pence < 0 then
    raise exception 'claim_product_order: invalid amounts' using errcode = '22023';
  end if;

  -- ── Is this a repeat of an attempt we already hold? ──────────────────────
  select * into v_order from public.product_orders
   where buyer_id = p_buyer and client_request_id = p_client_request_id
   for update;

  if not found then
    -- Not yet. Claim it. ON CONFLICT DO NOTHING waits for a concurrent inserter of the same (buyer, id) to commit or abort,
    -- so a race loser lands in the replay branch below once the winner is visible — and if the winner aborted (a sold-out line
    -- rolls its insert back) the loser simply proceeds to claim it itself.
    insert into public.product_orders
      (business_id, buyer_id, status, fulfilment, items_pence, shipping_pence, total_pence, commission_pence,
       delivery_name, delivery_address, delivery_postcode, delivery_region_slug, contact_phone, buyer_note,
       expires_at, client_request_id, pay_mode)
    values
      (p_business, p_buyer, 'pending', p_fulfilment, p_items_pence, p_shipping_pence, p_total_pence, p_commission_pence,
       p_delivery_name, p_delivery_address, p_delivery_postcode, p_delivery_region, p_contact_phone, p_buyer_note,
       now() + make_interval(mins => greatest(1, coalesce(p_ttl_minutes, 30))), p_client_request_id, p_pay_mode)
    on conflict (buyer_id, client_request_id) where client_request_id is not null do nothing
    returning id into v_id;

    if v_id is not null then
      -- We own the attempt. Reserve stock for every line in THIS transaction: a sold-out line aborts the whole claim —
      -- the order row and every earlier reservation disappear together, and nothing can be released twice.
      -- In a fixed order (product, then variant), so two baskets holding the same products cannot lock them in opposite orders.
      for v_line in
        select x from jsonb_array_elements(p_items) x order by x->>'product_id', coalesce(x->>'variant_id', '')
      loop
        select public.reserve_product_stock(
          (v_line->>'product_id')::uuid,
          nullif(v_line->>'variant_id', '')::uuid,
          (v_line->>'qty')::int
        ) into v_ok;
        if not coalesce(v_ok, false) then
          raise exception 'SOLD_OUT: %', coalesce(v_line->>'title', 'An item') using errcode = 'P0001';
        end if;
      end loop;

      insert into public.product_order_items (order_id, product_id, variant_id, title, variant_name, unit_pence, qty, photo_url)
      select v_id, (x->>'product_id')::uuid, nullif(x->>'variant_id', '')::uuid, x->>'title',
             nullif(x->>'variant_name', ''), (x->>'unit_pence')::int, (x->>'qty')::int, nullif(x->>'photo_url', '')
        from jsonb_array_elements(p_items) x;

      return jsonb_build_object(
        'order_id', v_id, 'replayed', false, 'status', 'pending', 'pay_mode', p_pay_mode,
        'payment_intent_id', null, 'total_pence', p_total_pence);
    end if;

    -- Lost the race: the winner's row is committed now.
    select * into v_order from public.product_orders
     where buyer_id = p_buyer and client_request_id = p_client_request_id
     for update;
    if not found then
      raise exception 'claim_product_order: attempt vanished while being claimed' using errcode = 'P0001';
    end if;
  end if;

  -- ── A repeat. It must be the SAME purchase. ──────────────────────────────
  if v_order.business_id is distinct from p_business
     or v_order.fulfilment is distinct from p_fulfilment
     or v_order.pay_mode is distinct from p_pay_mode
     or v_order.items_pence is distinct from p_items_pence
     or v_order.shipping_pence is distinct from p_shipping_pence
     or v_order.total_pence is distinct from p_total_pence
     or v_order.commission_pence is distinct from p_commission_pence
     or v_order.delivery_name is distinct from p_delivery_name
     or v_order.delivery_address is distinct from p_delivery_address
     or v_order.delivery_postcode is distinct from p_delivery_postcode
     or v_order.delivery_region_slug is distinct from p_delivery_region
     or v_order.contact_phone is distinct from p_contact_phone
     or v_order.buyer_note is distinct from p_buyer_note then
    raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference belongs to a different order' using errcode = 'P0001';
  end if;

  select count(*) into v_diff from (
    (select product_id, variant_id, qty, unit_pence from public.product_order_items where order_id = v_order.id
     except all
     select (x->>'product_id')::uuid, nullif(x->>'variant_id', '')::uuid, (x->>'qty')::int, (x->>'unit_pence')::int
       from jsonb_array_elements(p_items) x)
    union all
    (select (x->>'product_id')::uuid, nullif(x->>'variant_id', '')::uuid, (x->>'qty')::int, (x->>'unit_pence')::int
       from jsonb_array_elements(p_items) x
     except all
     select product_id, variant_id, qty, unit_pence from public.product_order_items where order_id = v_order.id)
  ) d;
  if v_diff > 0 then
    raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference was used for a different basket' using errcode = 'P0001';
  end if;

  -- A pending order past its time limit is dead whether or not the sweeper has run yet; finish it HERE, once, with the stock.
  if v_order.status = 'pending' and v_order.expires_at is not null and v_order.expires_at < now() then
    if public.cancel_pending_product_order(v_order.id, 'expired') then
      v_order.status := 'expired';
    else
      select * into v_order from public.product_orders where id = v_order.id;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'replayed', true, 'status', v_order.status, 'pay_mode', v_order.pay_mode,
    'payment_intent_id', v_order.payment_intent_id, 'total_pence', v_order.total_pence);
end;
$$;

-- ── cancel_pending_product_order ────────────────────────────────────────────
-- pending → cancelled | expired, and the stock goes back — exactly once. The status flip is the guard: of any number of
-- racing callers (the request that failed, the retry, the expiry sweeper) only the one that flips releases anything.
create or replace function public.cancel_pending_product_order(p_order uuid, p_as text default 'cancelled')
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_it record;
begin
  if p_as not in ('cancelled', 'expired') then
    raise exception 'cancel_pending_product_order: bad status' using errcode = '22023';
  end if;
  update public.product_orders
     set status = p_as,
         cancelled_at = case when p_as = 'cancelled' then now() else cancelled_at end,
         processing_claimed_at = null
   where id = p_order and status = 'pending'
   returning id into v_id;
  if v_id is null then
    return false;
  end if;
  for v_it in select product_id, variant_id, qty from public.product_order_items where order_id = p_order loop
    if v_it.product_id is not null then
      perform public.release_product_stock(v_it.product_id, v_it.variant_id, v_it.qty);
    end if;
  end loop;
  return true;
end;
$$;

-- ── claim_gift_purchase ──────────────────────────────────────────────────────────────
-- Same contract for gifts. Returns { gift_id, replayed, status, pay_mode, payment_intent_id }.
create or replace function public.claim_gift_purchase(
  p_purchaser           uuid,
  p_client_request_id   text,
  p_pay_mode            text,
  p_kind                text,
  p_unit_item_id        uuid,
  p_service_id          uuid,
  p_business_id         uuid,
  p_recipient_email     text,
  p_recipient_name      text,
  p_message             text,
  p_price_pence         integer
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_gift public.book_gifts;
  v_id   uuid;
begin
  if p_purchaser is null or p_business_id is null then
    raise exception 'claim_gift_purchase: purchaser and business are required' using errcode = '22023';
  end if;
  if p_client_request_id is null or char_length(p_client_request_id) < 8 or char_length(p_client_request_id) > 100 then
    raise exception 'claim_gift_purchase: client_request_id must be 8-100 characters' using errcode = '22023';
  end if;
  if p_pay_mode is null or p_pay_mode not in ('wallet', 'card_form', 'card_saved') then
    raise exception 'claim_gift_purchase: bad pay_mode' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('unit', 'booking') then
    raise exception 'claim_gift_purchase: bad kind' using errcode = '22023';
  end if;
  if p_price_pence is null or p_price_pence < 0 then
    raise exception 'claim_gift_purchase: invalid amount' using errcode = '22023';
  end if;

  select * into v_gift from public.book_gifts
   where purchaser_id = p_purchaser and client_request_id = p_client_request_id
   for update;

  if not found then
    insert into public.book_gifts
      (kind, status, code, business_id, unit_item_id, service_id, purchaser_id, recipient_email, recipient_name, message,
       price_paid_pence, client_request_id, pay_mode)
    values
      (p_kind, 'pending_payment', gen_random_uuid()::text,   -- placeholder; the short code is minted when the payment lands
       p_business_id, p_unit_item_id, p_service_id, p_purchaser, p_recipient_email, p_recipient_name, p_message,
       p_price_pence, p_client_request_id, p_pay_mode)
    on conflict (purchaser_id, client_request_id) where client_request_id is not null do nothing
    returning id into v_id;

    if v_id is not null then
      return jsonb_build_object('gift_id', v_id, 'replayed', false, 'status', 'pending_payment',
                                'pay_mode', p_pay_mode, 'payment_intent_id', null);
    end if;

    select * into v_gift from public.book_gifts
     where purchaser_id = p_purchaser and client_request_id = p_client_request_id
     for update;
    if not found then
      raise exception 'claim_gift_purchase: attempt vanished while being claimed' using errcode = 'P0001';
    end if;
  end if;

  if v_gift.kind is distinct from p_kind
     or v_gift.business_id is distinct from p_business_id
     or v_gift.unit_item_id is distinct from p_unit_item_id
     or v_gift.service_id is distinct from p_service_id
     or v_gift.recipient_email is distinct from p_recipient_email
     or v_gift.recipient_name is distinct from p_recipient_name
     or v_gift.message is distinct from p_message
     or v_gift.price_paid_pence is distinct from p_price_pence
     or v_gift.pay_mode is distinct from p_pay_mode then
    raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference belongs to a different gift' using errcode = 'P0001';
  end if;

  return jsonb_build_object('gift_id', v_gift.id, 'replayed', true, 'status', v_gift.status,
                            'pay_mode', v_gift.pay_mode, 'payment_intent_id', v_gift.payment_intent_id);
end;
$$;

-- ── cancel_pending_gift ─────────────────────────────────────────────────────
-- A gift whose payment definitively failed is CANCELLED, not deleted: deleting let a concurrent repeat succeed against a row
-- that had just vanished. Only a gift still awaiting payment can be cancelled; once it is sent / claimed / used it is paid and
-- cannot be. (If a payment lands just after a cancel, fulfilment promotes any gift that is not yet sent, so a paid gift is
-- never stranded as cancelled.)
create or replace function public.cancel_pending_gift(p_gift uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id uuid;
begin
  update public.book_gifts
     set status = 'cancelled', processing_claimed_at = null
   where id = p_gift and status = 'pending_payment'
   returning id into v_id;
  return v_id is not null;
end;
$$;

-- ── the processing lease ────────────────────────────────────────────────────
-- true  → you hold the lease: you alone create the PaymentIntent / run the wallet debit now.
-- false → someone else holds a live lease, or the attempt is no longer pending: move no money.
create or replace function public.claim_purchase_processing(p_kind text, p_id uuid, p_lease_seconds integer default 90)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_ok boolean;
begin
  if p_kind = 'product_order' then
    update public.product_orders set processing_claimed_at = now()
     where id = p_id and status = 'pending'
       and (processing_claimed_at is null or processing_claimed_at < now() - make_interval(secs => greatest(1, p_lease_seconds)))
     returning true into v_ok;
  elsif p_kind = 'gift' then
    update public.book_gifts set processing_claimed_at = now()
     where id = p_id and status = 'pending_payment'
       and (processing_claimed_at is null or processing_claimed_at < now() - make_interval(secs => greatest(1, p_lease_seconds)))
     returning true into v_ok;
  else
    raise exception 'claim_purchase_processing: unknown kind' using errcode = '22023';
  end if;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_purchase_processing(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_kind = 'product_order' then
    update public.product_orders set processing_claimed_at = null where id = p_id;
  elsif p_kind = 'gift' then
    update public.book_gifts set processing_claimed_at = null where id = p_id;
  else
    raise exception 'release_purchase_processing: unknown kind' using errcode = '22023';
  end if;
end;
$$;

-- ── privileges: server only ─────────────────────────────────────────────────
revoke all on function public.claim_product_order(uuid, text, text, uuid, text, jsonb, integer, integer, integer, integer, text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.cancel_pending_product_order(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_gift_purchase(uuid, text, text, text, uuid, uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.cancel_pending_gift(uuid) from public, anon, authenticated;
revoke all on function public.claim_purchase_processing(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_purchase_processing(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_product_order(uuid, text, text, uuid, text, jsonb, integer, integer, integer, integer, text, text, text, text, text, text, integer) to service_role;
grant execute on function public.cancel_pending_product_order(uuid, text) to service_role;
grant execute on function public.claim_gift_purchase(uuid, text, text, text, uuid, uuid, uuid, text, text, text, integer) to service_role;
grant execute on function public.cancel_pending_gift(uuid) to service_role;
grant execute on function public.claim_purchase_processing(text, uuid, integer) to service_role;
grant execute on function public.release_purchase_processing(text, uuid) to service_role;

-- Self-check: the indexes exist, and none of the six functions is callable by a client role.
do $check$
declare f text;
begin
  for f in select unnest(array[
    'public.claim_product_order(uuid, text, text, uuid, text, jsonb, integer, integer, integer, integer, text, text, text, text, text, text, integer)',
    'public.cancel_pending_product_order(uuid, text)',
    'public.claim_gift_purchase(uuid, text, text, text, uuid, uuid, uuid, text, text, text, integer)',
    'public.cancel_pending_gift(uuid)',
    'public.claim_purchase_processing(text, uuid, integer)',
    'public.release_purchase_processing(text, uuid)'
  ]) loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception '% must be service_role only', f;
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '% must be executable by service_role', f;
    end if;
  end loop;
  if (select count(*) from pg_indexes where schemaname = 'public' and indexname in
        ('product_orders_buyer_request_key', 'product_orders_payment_intent_key',
         'book_gifts_purchaser_request_key', 'book_gifts_payment_intent_key')) <> 4 then
    raise exception 'purchase attempt indexes are missing';
  end if;
end
$check$;

commit;
