-- ═══════════════════════════════════════════════════════════════════════════
-- Does this person's saved card pay for something that renews?
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Remove card said "You can add one again any time." For most people that is
-- the whole truth. For somebody whose subscription renews on that very card it
-- is not: the card is detached PERMANENTLY at Stripe, and adding a replacement
-- does not by itself repoint a subscription that is still holding the dead one.
--
-- Product policy is that removal is never blocked — but the consequence has to
-- be said before the button is pressed. The screens therefore need one bit of
-- information, and it must come from the server: which Stripe Customer funds a
-- subscription is decided by columns a client may not read.
--
-- Returns a boolean and nothing else. No Stripe id, no business id, no count
-- that could be correlated — the caller learns only whether the warning
-- applies to them.

create or replace function public.has_card_funded_subscription()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
      from public.local_businesses b
      join public.profiles p on p.id = b.owner_id
     where b.owner_id = auth.uid()
       and b.stripe_subscription_id is not null
       -- The subscription is billed through the OWNER'S PERSONAL Customer.
       -- A business with its own Stripe Customer is unaffected by the personal
       -- card being removed, and must not raise a warning that does not apply.
       and p.stripe_customer_id is not null
       and b.stripe_customer_id is not distinct from p.stripe_customer_id
       -- Already lapsed subscriptions have no next renewal to warn about.
       and (b.subscription_until is null or b.subscription_until > now())
  );
$$;

comment on function public.has_card_funded_subscription() is
  'True when the caller has an active subscription billed through their PERSONAL Stripe Customer, so removing their saved card would leave the next renewal without a payment method. Returns a bare boolean: the screens need the warning, not the identifiers.';

revoke execute on function public.has_card_funded_subscription() from anon, public;
grant  execute on function public.has_card_funded_subscription() to authenticated, service_role;
