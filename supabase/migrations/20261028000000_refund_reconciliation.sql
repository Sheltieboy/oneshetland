-- Refund reconciliation: did the MERCHANT's money come back, not just the customer's?
--
-- A destination charge sends the full amount to the connected account and
-- collects our fee from it. Refunding the customer does neither reversal
-- unless the refund asks for it. Two real live event-ticket refunds (25 Sep
-- 2026) refunded the customer but left the transfers un-reversed and the
-- application fees un-refunded, while event_ticket_orders said "refunded".
--
-- refund_reconciliation records, per refunded charge, what Stripe says about
-- the three legs (customer refund, transfer reversal, fee refund) and a
-- derived state. It is a snapshot of Stripe plus a verdict, not a ledger:
-- Stripe stays the source of truth and every check recomputes from it.
--
-- Service-role only: RLS on, no policies, all grants revoked.

insert into public.admin_config (key, value, description, category) values
  ('refunds.reconcile.auto_repair_enabled', 'true',
   'Refund reconciliation — when "true", a RECENT, FULL refund of an event-ticket destination charge whose merchant transfer was not reversed is repaired automatically (transfer reversed with the platform fee refunded). Set "false" to flag only. Other rails, partial refunds and old refunds are never repaired automatically.',
   'fees'),
  ('refunds.reconcile.auto_repair_max_age_hours', '72',
   'Refund reconciliation — a refund older than this many hours is never repaired automatically (it is flagged for a person), so a historical refund or a webhook re-sent from the Dashboard cannot trigger a clawback.',
   'fees')
on conflict (key) do update
  set value = excluded.value, description = excluded.description, category = excluded.category;

create table if not exists public.refund_reconciliation (
  charge_id               text primary key,
  payment_intent_id       text,
  rail                    text not null default 'other',
  order_id                uuid,
  state                   text not null
                            check (state in ('reconciled', 'repaired', 'needs_repair', 'needs_review', 'repair_failed')),
  charge_amount_pence     integer not null,
  amount_refunded_pence   integer not null,
  transfer_id             text,
  transfer_amount_pence   integer,
  transfer_reversed_pence integer,
  fee_id                  text,
  fee_amount_pence        integer,
  fee_refunded_pence      integer,
  transfer_gap_pence      integer not null default 0,
  fee_gap_pence           integer not null default 0,
  repair_attempts         integer not null default 0,
  repair_claimed_at       timestamptz,
  last_error              text,
  last_refund_at          timestamptz,
  first_flagged_at        timestamptz,
  repaired_at             timestamptz,
  last_checked_at         timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_refund_reconciliation_open
  on public.refund_reconciliation (state)
  where state in ('needs_repair', 'needs_review', 'repair_failed');
create index if not exists idx_refund_reconciliation_pi
  on public.refund_reconciliation (payment_intent_id);

-- Append-only audit of what was detected, repaired or refused, and by whom.
create table if not exists public.refund_reconciliation_events (
  id          uuid primary key default gen_random_uuid(),
  charge_id   text not null,
  kind        text not null check (kind in ('detected', 'repaired', 'repair_failed', 'verified', 'review')),
  actor       text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_refund_reconciliation_events_charge
  on public.refund_reconciliation_events (charge_id, created_at desc);

revoke all on public.refund_reconciliation from public, anon, authenticated;
revoke all on public.refund_reconciliation_events from public, anon, authenticated;
alter table public.refund_reconciliation enable row level security;
alter table public.refund_reconciliation_events enable row level security;

-- Refunded event orders with their reconciliation verdict. 'unverified' means
-- nothing has yet confirmed the merchant's money came back — an order row
-- saying "refunded" is NOT a reconciled refund.
create or replace view public.event_refund_reconciliation as
select o.id                         as order_id,
       o.stripe_payment_intent_id   as payment_intent_id,
       o.status                     as order_status,
       o.total_pence,
       o.platform_fee_pence,
       o.refunded_at,
       coalesce(r.state, 'unverified') as reconciliation_state,
       r.transfer_gap_pence,
       r.fee_gap_pence,
       r.last_checked_at
  from public.event_ticket_orders o
  left join public.refund_reconciliation r on r.payment_intent_id = o.stripe_payment_intent_id
 where o.status = 'refunded' or o.refunded_at is not null;

revoke all on public.event_refund_reconciliation from public, anon, authenticated;

-- Flag-only sweep. The function it calls never moves money; it re-checks every
-- recently refunded charge and anything still flagged. Same pg_cron -> pg_net
-- -> x-cron-secret (Vault) pattern as the other schedulers; scheduling an
-- existing job name replaces it, so re-running never creates a second job.
select cron.schedule(
  'refund-reconcile-sweep',
  '*/30 * * * *',
  $cron$
    select net.http_post(
      url := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/refund-reconcile-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cron$
);
