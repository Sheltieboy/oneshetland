-- ============================================================================
-- Stripe events become at-most-once, and a refunded ticket stops working.
--
-- WHAT WAS WRONG
--
-- 1. NO STRIPE EVENT LEDGER. Nothing in the database recorded which Stripe
--    event ids had been handled, so every guarantee against replay was
--    whatever the individual handler happened to provide.
--
--    Most of them turned out to provide a good one. The fulfilByType family
--    already guards on a UNIQUE payment-intent column or a conditional UPDATE:
--
--      event tickets   CAS on event_ticket_orders.status = 'pending'
--      product orders  CAS on product_orders.status = 'pending'
--      gifts           CAS excluding status in (sent, claimed, used)
--      wallet top-up   RPC returns already_credited
--      unit purchase   UNIQUE book_unit_purchases.payment_intent_id
--      hub donation    UNIQUE hub_donations.stripe_payment_intent_id
--      hub membership  UNIQUE, plus 23505 handling
--
--    That is domain-level idempotency, and it is real. It is NOT event-level
--    idempotency, and it did not cover everything.
--
-- 2. BOOST WAS NOT COVERED, AND BOOST IS THE ONE THAT PAYS OUT. The handler
--    read local_businesses.subscription_until, added the purchased weeks, and
--    wrote it back — deliberately stacking, so a customer can buy consecutive
--    boosts. Replay stacks just as happily. Reproduced against the production
--    schema: ONE paid two-week boost, delivered three times, granted SIX weeks
--    — 28 free days. The UNIQUE constraint on
--    local_boost_purchases.stripe_payment_intent_id did not help, because this
--    path UPDATEs that row rather than inserting it.
--
-- 3. A REFUNDED TICKET STILL OPENED THE DOOR. charge.refunded updated
--    delivery_requests and nothing else. A ticket payment intent matches no
--    delivery row, so a fully refunded ticket order stayed status='paid', its
--    tickets stayed 'valid', and Step 4's scanner — correctly, given the data —
--    answered VALID. Reproduced end to end.
--
-- WHAT REPLACES IT
--
-- A claim ledger keyed on the Stripe event id, and an authoritative refund
-- path. The ledger is the first layer; the existing domain CAS guards stay as
-- the second. Neither is asked to be sufficient on its own — an event id row
-- does not prove work happened, and this migration is careful never to treat
-- it as if it did.
-- ============================================================================


-- ── The ledger ──────────────────────────────────────────────────────────────
--
-- One row per Stripe event id, and the primary key IS the invariant. Two
-- concurrent deliveries of the same event contend on that key; one inserts and
-- the other does not.
--
-- No event payload is stored. The event type and the object id are enough to
-- investigate an incident, and Stripe remains the system of record for the
-- content. Storing payloads here would put card metadata, email addresses and
-- amounts in a table that exists only for deduplication.
--
-- RETENTION: rows are kept indefinitely and deliberately. Deleting them
-- reopens replay for any event Stripe can still retry, the volume is a few
-- hundred rows a month, and a cleanup job would be one more thing that can
-- fail silently. If this ever grows enough to matter, delete only rows older
-- than Stripe's maximum retry horizon — not by row count.
create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type      text        not null,
  object_id       text,
  status          text        not null default 'processing'
                    check (status in ('processing', 'processed', 'failed')),
  attempts        integer     not null default 1,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  last_error      text
);

comment on table public.stripe_webhook_events is
  'One row per Stripe event id. The primary key is the at-most-once invariant for webhook side effects. No event payload is stored — Stripe remains the system of record. Rows are retained indefinitely; see the migration header.';

create index if not exists idx_stripe_webhook_events_received
  on public.stripe_webhook_events (received_at desc);

-- Nobody but the service role goes near this. RLS is enabled with NO policies,
-- so even if a grant were ever added by accident, there is no policy to satisfy.
alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public;
revoke all on table public.stripe_webhook_events from anon;
revoke all on table public.stripe_webhook_events from authenticated;
grant all on table public.stripe_webhook_events to service_role;


-- ── Claiming an event ───────────────────────────────────────────────────────
--
-- Four outcomes, because collapsing them is how replay protection turns into
-- data loss:
--
--   claimed           new event, or a previous attempt that failed / died —
--                     the caller should process it
--   already_processed a previous attempt finished — acknowledge, do nothing
--   in_progress       another delivery is mid-flight right now
--
-- The 'failed' and stale-'processing' cases both RE-claim. That is the whole
-- point: an event whose first attempt crashed halfway through has not been
-- fulfilled, and must not be locked out by the row its own crash left behind.
--
-- The stale window is generous relative to an edge function's lifetime (which
-- is measured in seconds), so a genuinely concurrent delivery is never mistaken
-- for a dead one.
create or replace function public.claim_stripe_event(
  p_event_id  text,
  p_type      text,
  p_object_id text default null,
  p_stale_after interval default interval '15 minutes'
) returns text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_row public.stripe_webhook_events%rowtype;
begin
  if p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'claim_stripe_event: a Stripe event id is required' using errcode = '22023';
  end if;

  -- The race is decided here. Both deliveries attempt the insert; the primary
  -- key lets exactly one through.
  insert into public.stripe_webhook_events (stripe_event_id, event_type, object_id, status)
  values (p_event_id, coalesce(p_type, 'unknown'), p_object_id, 'processing')
  on conflict (stripe_event_id) do nothing
  returning * into v_row;

  if found then
    return 'claimed';
  end if;

  -- Someone got there first. Lock their row so two retries cannot both decide
  -- it is stale and both re-claim it.
  select * into v_row
    from public.stripe_webhook_events
   where stripe_event_id = p_event_id
     for update;

  if not found then
    -- Vanishingly unlikely (deleted between the two statements), but returning
    -- 'in_progress' asks Stripe to retry rather than guessing.
    return 'in_progress';
  end if;

  if v_row.status = 'processed' then
    return 'already_processed';
  end if;

  if v_row.status = 'failed'
     or (v_row.status = 'processing' and v_row.received_at < now() - p_stale_after) then
    update public.stripe_webhook_events
       set status      = 'processing',
           attempts    = attempts + 1,
           received_at = now(),
           last_error  = null
     where stripe_event_id = p_event_id;
    return 'claimed';
  end if;

  return 'in_progress';
end;
$$;

comment on function public.claim_stripe_event(text, text, text, interval) is
  'Claims a Stripe event id for processing. Returns claimed / already_processed / in_progress. A failed or stale-processing row is re-claimed, so an attempt that died mid-flight stays retryable — an event id row is never treated as proof the work was done.';


create or replace function public.mark_stripe_event_processed(p_event_id text)
returns boolean
  language sql
  security definer
  set search_path = public
as $$
  update public.stripe_webhook_events
     set status = 'processed', processed_at = now(), last_error = null
   where stripe_event_id = p_event_id
     and status <> 'processed'
  returning true;
$$;

comment on function public.mark_stripe_event_processed(text) is
  'Marks a claimed Stripe event as finished. Call only after the side effects actually succeeded.';


create or replace function public.mark_stripe_event_failed(
  p_event_id text,
  p_error    text default null
) returns boolean
  language sql
  security definer
  set search_path = public
as $$
  update public.stripe_webhook_events
     set status = 'failed',
         -- Truncated: this is an operational breadcrumb, not a log sink, and a
         -- Stripe error body can carry more than we want to keep.
         last_error = left(coalesce(p_error, 'unknown'), 500)
   where stripe_event_id = p_event_id
     and status <> 'processed'
  returning true;
$$;

comment on function public.mark_stripe_event_failed(text, text) is
  'Marks a claimed Stripe event as failed so a later delivery re-claims it. Never overwrites a processed row.';


-- ── Ticket refunds become authoritative ─────────────────────────────────────

alter table public.event_ticket_orders
  add column if not exists refunded_at timestamptz;

comment on column public.event_ticket_orders.refunded_at is
  'Set when a full Stripe refund was applied to this order. Historical orders predate the column and stay null.';

-- Supports the payment-intent lookup below. The UNIQUE constraint on
-- stripe_payment_intent_id already indexes it, so this is only a note that the
-- lookup is by that column and nothing else.

create or replace function public.refund_event_tickets_for_payment(
  p_payment_intent_id text,
  p_fully_refunded    boolean
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_order    public.event_ticket_orders%rowtype;
  v_claimed  uuid;
  v_voided   int := 0;
  v_kept     int := 0;
begin
  if p_payment_intent_id is null or btrim(p_payment_intent_id) = '' then
    return jsonb_build_object('matched', false, 'reason', 'no payment intent');
  end if;

  -- The ONLY mapping used. stripe_payment_intent_id is UNIQUE on this table and
  -- is written by the checkout that created the order, so it is authoritative.
  -- Nothing here trusts an order id, a user id or any other value carried in
  -- webhook metadata.
  select * into v_order
    from public.event_ticket_orders
   where stripe_payment_intent_id = p_payment_intent_id;

  if not found then
    -- Almost every refund is for something else entirely (a delivery, a
    -- product). Not matching is the normal case, not an error.
    return jsonb_build_object('matched', false, 'reason', 'not a ticket order');
  end if;

  -- ── Partial refunds are deliberately NOT mapped ──────────────────────────
  -- Nothing in the schema says which of an order's tickets a partial refund
  -- paid back. Voiding all of them would turn away attendees who are still
  -- owed entry, and voiding an arbitrary subset would be worse. So this
  -- records the ambiguity and changes nothing, rather than inventing a rule.
  if p_fully_refunded is not true then
    return jsonb_build_object(
      'matched',   true,
      'order_id',  v_order.id,
      'action',    'partial_refund_not_mapped',
      'message',   'Partial refund on a ticket order — no ticket was voided because the schema cannot say which tickets it covers. Needs a human.'
    );
  end if;

  -- ── Claim the order ─────────────────────────────────────────────────────
  -- Conditional on status='paid', so a second delivery of the same refund
  -- matches zero rows and every effect below is skipped. This is the domain
  -- layer of idempotency; the event ledger is the other.
  update public.event_ticket_orders
     set status = 'refunded', refunded_at = now()
   where id = v_order.id
     and status = 'paid'
  returning id into v_claimed;

  if v_claimed is null then
    return jsonb_build_object(
      'matched',  true,
      'order_id', v_order.id,
      'action',   'already_refunded',
      'status',   (select status from public.event_ticket_orders where id = v_order.id)
    );
  end if;

  -- ── Void the tickets that can still be used ─────────────────────────────
  -- Only 'valid' rows. The predicate is what makes this safe against the door:
  -- a scan racing this refund is the same single-row contention Step 4 built —
  -- whichever statement takes the row lock first wins, and the loser matches
  -- nothing. There is no ordering in which a ticket is both admitted here and
  -- voided there.
  update public.event_tickets
     set status = 'refunded'
   where order_id = v_order.id
     and status   = 'valid';
  get diagnostics v_voided = row_count;

  -- Tickets already spent stay 'used'. Somebody walked through the door, and
  -- overwriting that with 'refunded' would replace a fact with a falsehood.
  -- They are already unusable — Step 4 only admits status='valid' — so nothing
  -- is gained by rewriting them, and the attendance record survives intact
  -- alongside its event_checkins rows.
  select count(*) into v_kept
    from public.event_tickets
   where order_id = v_order.id and status = 'used';

  -- ── Capacity is deliberately NOT returned ───────────────────────────────
  -- The only capacity-release path this system has ever had is
  -- release_ticket_order, and it refuses anything that is not a pending,
  -- unpaid hold. Nothing releases a seat that was actually sold. Whether a
  -- refunded seat goes back on sale is a business decision — it depends on how
  -- close the event is and whether the organiser wants it — and inventing that
  -- policy here would be overreach.
  --
  -- It is also the safe direction. Not releasing can only ever undersell.
  -- Releasing wrongly sells the same seat twice. And because no counter moves,
  -- a duplicate refund cannot move one twice: there is nothing to move.
  return jsonb_build_object(
    'matched',          true,
    'order_id',         v_order.id,
    'event_id',         v_order.event_id,
    'action',           'refunded',
    'tickets_voided',   v_voided,
    'tickets_kept_used', v_kept,
    'capacity_changed', false
  );
end;
$$;

comment on function public.refund_event_tickets_for_payment(text, boolean) is
  'Authoritative ticket refund. Maps a Stripe payment intent to its order via the UNIQUE stripe_payment_intent_id, claims the order with a conditional paid->refunded update, and voids only tickets still status=valid. Already-used tickets keep their status so attendance is not erased. Capacity is never returned to sale, so a duplicate refund cannot adjust it twice. Partial refunds are reported, not mapped.';


-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- Postgres re-grants EXECUTE to PUBLIC at CREATE time, and a revoke naming
-- fewer than {public, anon, authenticated} is a no-op in one direction or the
-- other. Steps 1 and 1B were both caused by exactly that, so all three are
-- always named and the grant is always restated.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.claim_stripe_event(text, text, text, interval)',
    'public.mark_stripe_event_processed(text)',
    'public.mark_stripe_event_failed(text, text)',
    'public.refund_event_tickets_for_payment(text, boolean)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
