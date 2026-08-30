-- ═══════════════════════════════════════════════════════════════════════════
-- The terms stop being a screen and start being a rule
-- ═══════════════════════════════════════════════════════════════════════════
--
-- W3G built an acceptance record nobody can fake. W3H put it in front of every
-- commercial screen on the website and the phone. Both of those are the UX
-- asking politely, and a screen is not a boundary: an authenticated owner with
-- the anon key and curl could create a product, publish an offer or open a
-- booking service without ever having seen §11.
--
-- ── Why this is a trigger and not a policy ─────────────────────────────────
--
-- The rule is not "which rows may exist" but "which CHANGES may be made", and
-- the difference matters in one specific case: a business that has not accepted
-- must still be able to take something down.
--
-- That came out of the first draft of this migration. Enforcing acceptance in
-- WITH CHECK blocked every UPDATE, and setting is_active = false is an UPDATE —
-- so an owner who declined the terms could no longer withdraw a live product,
-- only delete it. Leaving customers looking at something the seller is trying
-- to withdraw is the wrong failure, especially the day the version moves.
--
-- A policy cannot tell those apart: WITH CHECK sees the new row, never the old
-- one, so it cannot know whether is_active went true → false or false → true.
-- A BEFORE trigger sees both. So the acceptance rule lives in one trigger
-- function, and every existing policy on these tables is left exactly as it is
-- — public reads, admin management, hub events, ticket-holder reads, all
-- untouched.
--
-- This is a real boundary, not a convention: `authenticated` cannot disable a
-- trigger and cannot set session_replication_role (measured, not assumed), so
-- PostgREST has no way around it.
--
-- ── What an owner without current acceptance may do ────────────────────────
--
--   create anything commercial            no
--   change price, content, availability   no
--   reactivate, republish, re-enable      no
--   withdraw an existing item             YES — and nothing else in the same
--                                         statement
--   delete                                yes, as before
--   read their own rows                   yes, as before
--   ordinary Directory management         yes, as before
--
-- Accepting the current version restores ordinary owner behaviour.

-- ── The predicate ──────────────────────────────────────────────────────────
--
-- Two facts, one answer: this user owns this business, AND has accepted the
-- CURRENT commercial terms for it through the protected path. The version is
-- not re-derived here — has_accepted_commercial_terms compares against
-- commercial_terms_version(), so a version move needs no change to any of this.
--
-- It is callable by `authenticated` because the Connect edge function and
-- future policy work may need it, and because W3G.1's lesson still applies —
-- a boolean about somebody else is still a boolean about somebody else — it
-- refuses to answer about anyone but the caller. Server paths have no JWT and
-- may ask about anyone.
create or replace function public.business_may_transact(
  p_business_id uuid,
  p_user_id     uuid
) returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
begin
  if p_business_id is null or p_user_id is null then
    return false;
  end if;

  if auth.uid() is not null and p_user_id is distinct from auth.uid() then
    raise exception 'business_may_transact: may only be asked about yourself'
      using errcode = '42501';
  end if;

  return exists (
           select 1 from public.local_businesses b
            where b.id = p_business_id and b.owner_id = p_user_id
         )
         and public.has_accepted_commercial_terms(p_business_id, p_user_id);
end;
$$;

comment on function public.business_may_transact(uuid, uuid) is
  'True when the user owns the business AND has accepted the current commercial terms for it. Refuses to answer about any user other than the caller; server paths (no JWT) may ask about anyone.';

revoke execute on function public.business_may_transact(uuid, uuid) from public;
grant  execute on function public.business_may_transact(uuid, uuid) to authenticated, service_role;

-- ── The guard ──────────────────────────────────────────────────────────────
--
-- One function for every commercial table. Each trigger passes two arguments:
--
--   [0]  the column naming the business — or 'product_id' to resolve through
--        the parent product, which is how variants hang off a business
--   [1]  the withdrawal spec: 'column=value[,value]' pairs separated by ';'
--
-- A change is a WITHDRAWAL when every column it touches is named in the spec,
-- the new value is one the spec allows, and the old value was not. That last
-- clause is what makes it reduction-only in both directions without having to
-- describe direction: is_active true → false qualifies, false → true does not,
-- and an event moving to 'cancelled' qualifies while leaving it does not.
create or replace function public.commercial_terms_write_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_business uuid;
  v_spec     text := coalesce(TG_ARGV[1], '');
  o          jsonb;
  n          jsonb;
  k          text;
  v_changed  text[] := '{}';
  v_pair     text;
  v_col      text;
  v_allowed  text[];
  v_ok       boolean;
begin
  -- DELETE is deliberately not guarded, and this is what makes that safe. On a
  -- BEFORE DELETE there is no NEW row, so everything below would read null and
  -- return null — which in a BEFORE DELETE means "skip this row", silently
  -- swallowing deletions instead of refusing them. If anyone ever wires DELETE
  -- into these triggers, it passes through rather than quietly doing nothing.
  if TG_OP = 'DELETE' then
    return old;
  end if;

  -- Server paths: webhooks, scheduled jobs, edge functions with the service
  -- key. They have no JWT and are not the seller.
  if v_uid is null then
    return new;
  end if;

  -- Platform staff, deliberately. The admin branches of these policies exist
  -- so somebody can put things right; this does not take that away.
  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;
  end if;

  n := to_jsonb(new);

  if TG_ARGV[0] = 'product_id' then
    select business_id into v_business from public.products
     where id = (n->>'product_id')::uuid;
  else
    v_business := nullif(n->>TG_ARGV[0], '')::uuid;
  end if;

  -- Not a business write at all. A community hub arranging a village show and
  -- a person organising their own event are not sellers, and never were.
  if v_business is null then
    return new;
  end if;

  if public.business_may_transact(v_business, v_uid) then
    return new;                                   -- ordinary owner behaviour
  end if;

  if TG_OP <> 'UPDATE' then
    raise exception 'Accept the business & selling terms for this business before adding or changing what it offers'
      using errcode = '42501',
            hint = 'Open any commercial screen on OneShetland to accept them.';
  end if;

  -- An UPDATE, without acceptance. The only thing allowed is taking something
  -- down — and only that, in the same statement.
  o := to_jsonb(old);
  for k in select jsonb_object_keys(n) loop
    if (n -> k) is distinct from (o -> k) and k <> 'updated_at' then
      v_changed := v_changed || k;
    end if;
  end loop;

  if array_length(v_changed, 1) is null then
    return new;                                   -- a no-op update changes nothing
  end if;

  foreach k in array v_changed loop
    v_ok := false;
    foreach v_pair in array string_to_array(v_spec, ';') loop
      v_col := split_part(v_pair, '=', 1);
      if v_col = k then
        v_allowed := string_to_array(split_part(v_pair, '=', 2), ',');
        -- Moving INTO a withdrawn value, and not already there.
        if (n->>k) = any (v_allowed) and ((o->>k) is null or not ((o->>k) = any (v_allowed))) then
          v_ok := true;
        end if;
      end if;
    end loop;
    if not v_ok then
      raise exception 'Accept the business & selling terms for this business before changing what it offers — you can still withdraw it, or delete it'
        using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.commercial_terms_write_guard() is
  'Requires current commercial-terms acceptance for business writes, with one exception: an owner who has not accepted may still withdraw an existing item, and may change nothing else in the same statement. Server paths and platform admins are exempt. DELETE is deliberately not guarded — withdrawing what you offer must never be blocked.';

-- ── The tables ─────────────────────────────────────────────────────────────
--
-- Withdrawal mechanisms are the product's own, not invented here:
--   is_active                              products, variants, services,
--                                          unit items, availability rules,
--                                          offers, loyalty programmes
--   collect/fetch/post_enabled             shipping — each turned off on its own
--   is_hidden, status                      events

drop trigger if exists commercial_terms_guard on public.products;
create trigger commercial_terms_guard before insert or update on public.products
  for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');

drop trigger if exists commercial_terms_guard on public.product_variants;
create trigger commercial_terms_guard before insert or update on public.product_variants
  for each row execute function public.commercial_terms_write_guard('product_id', 'is_active=false');

drop trigger if exists commercial_terms_guard on public.business_shipping;
create trigger commercial_terms_guard before insert or update on public.business_shipping
  for each row execute function public.commercial_terms_write_guard(
    'business_id', 'collect_enabled=false;fetch_enabled=false;post_enabled=false');

drop trigger if exists commercial_terms_guard on public.book_services;
create trigger commercial_terms_guard before insert or update on public.book_services
  for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');

drop trigger if exists commercial_terms_guard on public.book_unit_items;
create trigger commercial_terms_guard before insert or update on public.book_unit_items
  for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');

drop trigger if exists commercial_terms_guard on public.book_availability_rules;
create trigger commercial_terms_guard before insert or update on public.book_availability_rules
  for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');

drop trigger if exists commercial_terms_guard on public.local_offers;
create trigger commercial_terms_guard before insert or update on public.local_offers
  for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');

drop trigger if exists commercial_terms_guard on public.local_loyalty_programs;
create trigger commercial_terms_guard before insert or update on public.local_loyalty_programs
  for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');

-- Events name a business only when a business is the organiser. Hub and
-- personal events pass through untouched, because organiser_business_id is null
-- for them and the guard returns before it asks about acceptance.
drop trigger if exists commercial_terms_guard on public.events;
create trigger commercial_terms_guard before insert or update on public.events
  for each row execute function public.commercial_terms_write_guard(
    'organiser_business_id', 'is_hidden=true;status=cancelled,archived');

-- ── local_businesses: the Directory must keep working ──────────────────────
--
-- The row holds a business's name, description, hours, photos and contact
-- details beside three columns that decide how it takes and receives money.
-- Only those three are guarded, and only when one of them actually changes —
-- editing your opening hours never reaches the check.
--
-- use_business_payment is deliberately absent: choosing which card the business
-- PAYS with is not seller activity.
--
-- One reduction is allowed without acceptance, for the same reason withdrawal
-- is allowed above: switching accepts_wallet off stops the business taking
-- wallet payments from customers, and stopping should never be harder than
-- starting. cashback_percent and use_business_payout are not reductions in any
-- direction — one changes what customers are promised, the other changes where
-- money lands — so both stay closed until the terms are accepted.
create or replace function public.local_businesses_commercial_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_wallet_changed  boolean := new.accepts_wallet      is distinct from old.accepts_wallet;
  v_cashback_change boolean := new.cashback_percent    is distinct from old.cashback_percent;
  v_payout_changed  boolean := new.use_business_payout is distinct from old.use_business_payout;
begin
  if not (v_wallet_changed or v_cashback_change or v_payout_changed) then
    return new;                     -- an ordinary Directory edit
  end if;

  if v_uid is null then
    return new;                     -- service role, webhooks, scheduled jobs
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;                     -- platform admin, deliberately
  end if;

  if public.business_may_transact(new.id, v_uid) then
    return new;
  end if;

  -- Not accepted. Switching wallet acceptance OFF is the one permitted move,
  -- and only if nothing else commercial changes with it.
  if v_wallet_changed
     and new.accepts_wallet is not true
     and not v_cashback_change
     and not v_payout_changed then
    return new;
  end if;

  raise exception 'Accept the business & selling terms for this business before changing how it takes or receives money'
    using errcode = '42501';
end;
$$;

comment on function public.local_businesses_commercial_guard() is
  'Gates accepts_wallet, cashback_percent and use_business_payout, and only when one of them is actually changing. Turning accepts_wallet off is permitted without acceptance — stopping must never be harder than starting. Ordinary Directory updates are untouched.';

drop trigger if exists local_businesses_commercial_guard on public.local_businesses;
create trigger local_businesses_commercial_guard
  before update on public.local_businesses
  for each row execute function public.local_businesses_commercial_guard();
