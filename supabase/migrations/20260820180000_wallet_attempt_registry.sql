-- ============================================================================
-- A wallet payment attempt becomes a durable thing that survives its own
-- failure.
--
-- WHAT WAS WRONG
--
-- Step 6 made the debit and the ledger atomic, and keyed the Stripe transfer on
-- the wallet transaction id. Two retry weaknesses survived it, and reproducing
-- them showed the second was a different shape than it looked.
--
-- FINDING A — wallet-checkout has no attempt identity.
--   Neither client sends client_request_id, so the four flows (hub donation,
--   hub membership, unit purchase, shift boost) call the debit primitive with a
--   null idempotency key. Reproduced: two identical 1000p purchases, two
--   distinct wallet transactions, two spend rows, 2000p gone. A double tap is
--   two purchases.
--
-- FINDING B — the claim is deleted after an ambiguous transfer.
--   local-wallet-pay deletes its wallet_payment_claims row on ANY failure,
--   including transfer_state='unresolved', where Stripe may well have moved the
--   money. Reproduced, and it splits in two:
--
--     retry with the SAME id  → the debit is correctly deduped (Step 6's key
--                               did that), but debitAndTransfer returns early on
--                               already_applied and NEVER RESUMES the transfer.
--                               The row stays 'unresolved' for ever and the
--                               customer is told the payment succeeded.
--
--     retry with a NEW id     → a second debit and a second transfer. And this
--                               is the real-world case: the mobile client mints
--                               its id inside the API helper, so every attempt
--                               gets a fresh one.
--
-- WHAT REPLACES IT
--
-- wallet_payment_claims stops being a thin duplicate-suppressor and becomes the
-- attempt registry: it remembers which wallet transaction an attempt owns, what
-- the attempt was FOR, and what state it reached. An attempt whose external
-- money movement is unresolved is accounting state, not a cache entry, and is
-- never released.
-- ============================================================================


-- ── The claim grows up ──────────────────────────────────────────────────────
--
-- Empty in production (0 rows), so the new columns can be added without a
-- backfill problem. Kept as one table rather than a second registry: it already
-- has the right primary key and the right owner column, and two competing
-- idempotency mechanisms on one payment path is how they drift.
alter table public.wallet_payment_claims
  add column if not exists wallet_transaction_id uuid
    references public.local_wallet_transactions(id),
  add column if not exists payload_fingerprint text,
  add column if not exists status text not null default 'in_flight',
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.wallet_payment_claims'::regclass
       and conname  = 'wallet_payment_claims_status_check'
  ) then
    alter table public.wallet_payment_claims
      add constraint wallet_payment_claims_status_check
      check (status in ('in_flight','unresolved','completed','reversed','failed'));
  end if;
end $$;

comment on column public.wallet_payment_claims.wallet_transaction_id is
  'The ledger row this attempt owns. This is the link that lets a retry resume the SAME transfer instead of starting a new payment.';
comment on column public.wallet_payment_claims.payload_fingerprint is
  'Hash of the authoritative instruction (user, type, recipient, resource, amount). Reusing an id with different instructions is a conflict, not a replay.';
comment on column public.wallet_payment_claims.status is
  'in_flight | unresolved | completed | reversed | failed. "unresolved" means Stripe may or may not have moved the money and the attempt must be resumed — it is never released and never reusable.';

create index if not exists wallet_payment_claims_unresolved_idx
  on public.wallet_payment_claims (created_at)
  where status = 'unresolved';

-- RETENTION: nothing is deleted, ever, and there is no cleanup job. An attempt
-- row is the only thing tying a client's retry to the money that already moved;
-- deleting a completed one reopens replay, and deleting an unresolved one
-- destroys the record of money that may be sitting with Stripe. Volume is a few
-- rows per payment. If it ever needs archiving, archive — do not expire.


-- ── Claiming an attempt ─────────────────────────────────────────────────────
--
-- Five outcomes, because collapsing them is how a retry becomes a second
-- payment or a customer gets told a stalled transfer succeeded:
--
--   claimed     new attempt — go and do the work
--   replay      a terminal attempt — return what happened, change nothing
--   resume      the money left the wallet but the transfer is unsettled —
--               pick up THAT transaction, do not start a new one
--   in_flight   another request is working on it right now
--   conflict    this id is already in use for something else, or by someone else
--
-- The race is decided by the primary key: both requests attempt the insert and
-- exactly one wins.
create or replace function public.claim_wallet_attempt(
  p_request_id  text,
  p_user        uuid,
  p_fingerprint text
) returns table (
  outcome               text,
  status                text,
  wallet_transaction_id uuid,
  result                jsonb
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_row public.wallet_payment_claims%rowtype;
begin
  if p_request_id is null or btrim(p_request_id) = '' then
    raise exception 'claim_wallet_attempt: a payment reference is required' using errcode = '22023';
  end if;
  if length(p_request_id) > 128 then
    raise exception 'claim_wallet_attempt: payment reference is too long' using errcode = '22023';
  end if;
  if p_user is null then
    raise exception 'claim_wallet_attempt: a user is required' using errcode = '22023';
  end if;

  insert into public.wallet_payment_claims
    (client_request_id, user_id, payload_fingerprint, status, updated_at)
  values
    (p_request_id, p_user, p_fingerprint, 'in_flight', now())
  on conflict (client_request_id) do nothing
  returning * into v_row;

  if found then
    return query select 'claimed'::text, 'in_flight'::text, null::uuid, null::jsonb;
    return;
  end if;

  -- Someone holds it. Lock the row so two retries cannot both decide to resume.
  select * into v_row from public.wallet_payment_claims
   where client_request_id = p_request_id
     for update;

  if not found then
    return query select 'in_flight'::text, 'in_flight'::text, null::uuid, null::jsonb;
    return;
  end if;

  -- A claim belongs to whoever took it. Never hand one person another's result,
  -- and never let one person's retry act on another person's money.
  if v_row.user_id is distinct from p_user then
    return query select 'conflict'::text, v_row.status, null::uuid, null::jsonb;
    return;
  end if;

  -- Payload binding. The same reference must mean the same instruction; a
  -- reference reused for a different amount or recipient is a bug or an attack,
  -- and either way it must not execute.
  if v_row.payload_fingerprint is not null
     and p_fingerprint is not null
     and v_row.payload_fingerprint is distinct from p_fingerprint then
    return query select 'conflict'::text, v_row.status, null::uuid, null::jsonb;
    return;
  end if;

  if v_row.status in ('completed', 'reversed', 'failed') then
    return query select 'replay'::text, v_row.status, v_row.wallet_transaction_id, v_row.result;
    return;
  end if;

  if v_row.status = 'unresolved' then
    return query select 'resume'::text, v_row.status, v_row.wallet_transaction_id, v_row.result;
    return;
  end if;

  return query select 'in_flight'::text, v_row.status, v_row.wallet_transaction_id, v_row.result;
end;
$$;

comment on function public.claim_wallet_attempt(text, uuid, text) is
  'Claims one logical wallet payment attempt. Returns claimed / replay / resume / in_flight / conflict. The primary key decides concurrent duplicates; the fingerprint stops one reference being reused for a different payment; an unresolved attempt returns resume so the retry picks up the SAME wallet transaction. service_role only.';


-- ── Recording where an attempt got to ───────────────────────────────────────
create or replace function public.settle_wallet_attempt(
  p_request_id text,
  p_status     text,
  p_txn        uuid    default null,
  p_result     jsonb   default null
) returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if p_status not in ('in_flight','unresolved','completed','reversed','failed') then
    raise exception 'settle_wallet_attempt: unknown status %', p_status using errcode = '22023';
  end if;

  update public.wallet_payment_claims
     set status                = p_status,
         -- Never clear a transaction link that is already known: it is the only
         -- route back to money that moved.
         wallet_transaction_id = coalesce(p_txn, wallet_transaction_id),
         result                = coalesce(p_result, result),
         completed_at          = case when p_status in ('completed','reversed','failed')
                                      then now() else completed_at end,
         updated_at            = now()
   where client_request_id = p_request_id
     -- A completed attempt is final. Nothing may walk it back to in_flight.
     and status <> 'completed';

  return found;
end;
$$;

comment on function public.settle_wallet_attempt(text, text, uuid, jsonb) is
  'Records the outcome of a wallet payment attempt. Never clears a known wallet_transaction_id, and never moves a completed attempt back to an earlier state. service_role only.';


-- ── Reading an attempt back ─────────────────────────────────────────────────
create or replace function public.get_wallet_attempt(
  p_request_id text,
  p_user       uuid
) returns table (
  status                text,
  wallet_transaction_id uuid,
  transfer_state        text,
  result                jsonb
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select c.status, c.wallet_transaction_id, t.transfer_state, c.result
    from public.wallet_payment_claims c
    left join public.local_wallet_transactions t on t.id = c.wallet_transaction_id
   where c.client_request_id = p_request_id
     and c.user_id = p_user;
$$;

comment on function public.get_wallet_attempt(text, uuid) is
  'Reads one attempt, scoped to its owner, together with the transfer state of the ledger row it owns.';


-- ── Privileges ──────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.claim_wallet_attempt(text, uuid, text)',
    'public.settle_wallet_attempt(text, text, uuid, jsonb)',
    'public.get_wallet_attempt(text, uuid)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

revoke all on table public.wallet_payment_claims from anon, authenticated;
grant all on table public.wallet_payment_claims to service_role;
