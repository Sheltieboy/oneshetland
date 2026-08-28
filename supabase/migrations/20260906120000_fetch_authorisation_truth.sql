-- ═══════════════════════════════════════════════════════════════════════════
-- A Fetch delivery is funded when Stripe says so, and not before
-- ═══════════════════════════════════════════════════════════════════════════
--
-- authorise-payment recorded `payment_status = 'authorised'` whenever the
-- PaymentIntent call returned HTTP 200. A 200 means Stripe accepted the
-- request, not that a hold exists: a card needing 3DS comes back 200 with
-- status `requires_action`, and a card that failed at confirm comes back 200
-- with `requires_payment_method`. Both were written down as authorised, the
-- customer was told "your card will be charged on delivery", and the driver
-- drove.
--
-- Two halves, and the second is why they are in one migration:
--
--   1. payment_status can now say what is actually true.
--   2. payment_status, payment_intent_id and total_fee_pence stop being
--      client-writable — otherwise correcting the status handling would just
--      move the forgery from Stripe's answer to a PATCH.

-- ── 1. States that can represent the truth ─────────────────────────────────
--
-- 'unpaid' is not stretched to cover all of this. The customer's screen has to
-- ask for the right thing (authenticate vs add a card) and the driver's screen
-- has to refuse to release them; one bucket cannot say which.
alter table public.delivery_requests
  drop constraint if exists delivery_requests_payment_status_check;

alter table public.delivery_requests
  add constraint delivery_requests_payment_status_check check (
    payment_status = any (array[
      'unpaid',                    -- nothing attempted
      'requires_action',           -- the customer's bank wants them to authenticate
      'requires_payment_method',   -- no usable card, or the card refused
      'processing',                -- Stripe has not finished; NOT a hold
      'authorised',               -- requires_capture: a genuine hold exists
      'captured',
      'refunded',
      'partially_refunded',
      'failed'
    ])
  );

comment on column public.delivery_requests.payment_status is
  'Only ''authorised'' means a Stripe hold exists (PaymentIntent requires_capture). requires_action / requires_payment_method / processing are all NOT funded and must not release a driver.';

-- ── 2. The payment fields become the server's ──────────────────────────────
--
-- Same mechanism as 20260819180000_lock_server_managed_columns and the Fix 1
-- money trigger: put the old value back rather than raising, so a client that
-- sends one is ignored and not broken.
create or replace function public.tg_fetch_payment_is_server_managed()
  returns trigger
  language plpgsql
  -- SECURITY INVOKER on purpose: tg_is_trusted_writer() reads current_user, and
  -- DEFINER would rebind it to the owner so every caller looked trusted.
  set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    new.payment_intent_id := null;
    new.payment_status    := coalesce(new.payment_status, 'unpaid');
    -- A new request is never already paid for, whatever it claims.
    if new.payment_status <> 'unpaid' then new.payment_status := 'unpaid'; end if;
    return new;
  end if;

  new.payment_intent_id := old.payment_intent_id;
  new.payment_status    := old.payment_status;

  -- ── The gate ────────────────────────────────────────────────────────────
  --
  -- Statuses past 'matched' assume the money is held. The driver's screen
  -- already refuses to offer them, but "the button is hidden" is not a
  -- protection — the driver has an UPDATE policy on their own matched rows and
  -- could simply PATCH the status. Collection and delivery now require a
  -- genuine hold, enforced where it cannot be skipped.
  --
  -- 'cancelled' is deliberately NOT gated: giving up must always be possible.
  if new.status is distinct from old.status
     and new.status in ('collected', 'delivered')
     and coalesce(old.payment_status, 'unpaid') not in ('authorised', 'captured')
  then
    raise exception 'This delivery is not authorised yet — the customer''s payment is %', coalesce(old.payment_status, 'unpaid')
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists delivery_requests_payment_server_managed on public.delivery_requests;
create trigger delivery_requests_payment_server_managed
  before insert or update on public.delivery_requests
  for each row execute function public.tg_fetch_payment_is_server_managed();

comment on function public.tg_fetch_payment_is_server_managed() is
  'payment_intent_id and payment_status are the server''s, and a delivery cannot be advanced to collected/delivered unless the money is genuinely held. RLS decides which rows you may write; this decides which columns, and which transitions.';
