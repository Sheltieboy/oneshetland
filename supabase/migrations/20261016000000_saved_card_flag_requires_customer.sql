-- ═══════════════════════════════════════════════════════════════════════════
-- has_payment_method cannot be true unless a Stripe Customer is bound
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A production audit found profiles with has_payment_method = true and NO
-- Stripe Customer bound — no profiles.stripe_customer_id and no settled row in
-- stripe_customer_claims. 4 of the 6 flagged profiles were like that. Checkout,
-- which resolves the card canonically, said "no saved card" while Account said
-- "card added", because Account believed the flag.
--
-- The flag is a cache of "the bound Customer has a card attached". A cache with
-- nothing to be a cache OF is a lie, and nothing stopped it being written.
--
-- WHAT THIS ADDS
--
--   1. A guard. No write — from any role, service_role included — can leave the
--      flag true on a profile with no bound Customer; it is set false instead.
--      This is the part the database CAN enforce. Whether the bound Customer
--      still has a card attached needs Stripe, so that half is kept honest by
--      the write path (confirm-card-setup, remove-card) and by the reconciler.
--
--   2. A schedule for that reconciler (reconcile-saved-cards), which corrects
--      drift in either direction — a card removed or added outside the app — and
--      recovers a Customer only on proof of ownership. Same mechanism as the
--      other scheduled functions: pg_cron → pg_net with x-cron-secret from Vault.
--
-- WHAT IT DOES NOT DO
--
--   It does not rewrite existing rows. The rows that are already inconsistent are
--   corrected by the reconciler, which can tell "recoverable" from "stale"; a
--   blanket UPDATE here could not, and would destroy the evidence of which was which.
--
-- Idempotent: safe to run more than once.

create or replace function public.tg_profiles_card_flag_needs_customer()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  if new.has_payment_method is true
     and coalesce(new.stripe_customer_id, '') = ''
     and not exists (
       select 1
         from public.stripe_customer_claims c
        where c.user_id = new.id
          and c.status = 'bound'
          and coalesce(c.stripe_customer_id, '') <> ''
     )
  then
    new.has_payment_method := false;
  end if;
  return new;
end;
$$;

comment on function public.tg_profiles_card_flag_needs_customer() is
  'has_payment_method may only be true when a Stripe Customer is bound (profile column or a settled claim). Whether that Customer still has a card is Stripe''s to say — see reconcile-saved-cards.';

drop trigger if exists trg_profiles_card_flag_needs_customer on public.profiles;
create trigger trg_profiles_card_flag_needs_customer
  before insert or update on public.profiles
  for each row execute function public.tg_profiles_card_flag_needs_customer();

-- ── The nightly reconciler ─────────────────────────────────────────────────
-- 03:25 UTC. cron.schedule with an existing job name replaces it, so re-running
-- this file never creates a second job.
select cron.schedule(
  'reconcile-saved-cards',
  '25 3 * * *',
  $cron$
    select net.http_post(
      url := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/reconcile-saved-cards',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$
);
