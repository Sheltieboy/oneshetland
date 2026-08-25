-- Paygate 6 — the donation becomes a record somebody can look at.
--
-- WHAT hub_donations ALREADY HAD
--
-- Almost everything: donor, hub, campaign, amount, fee, message, anonymity,
-- Gift Aid, the payment reference and a timestamp. No second receipt table is
-- needed and none is added. Three things were missing or unsafe.
--
-- 1. HOW IT WAS PAID could only be inferred by looking at the shape of
--    stripe_payment_intent_id — 'pi_…' for card, 'wallet_…' for a wallet
--    transaction id. That prefix is written by our own code, so it is real
--    evidence, but reading it in every query is the kind of thing that is true
--    until somebody changes a string. Recorded explicitly instead, at the
--    moment the donation is written.
--
-- 2. THE HISTORY WAS NOT DURABLE. Both foreign keys were ON DELETE CASCADE:
--
--       campaign_id -> hub_campaigns  ON DELETE CASCADE
--       hub_id      -> hubs           ON DELETE CASCADE
--
--    Deleting a campaign or a hub would have deleted every donation to it —
--    somebody's giving history erased because the fundraiser was tidied away.
--    No screen in either client deletes a campaign or a hub today (they close
--    and reopen), so nothing has been lost. It was one admin action away from
--    happening, which is not a margin worth keeping.
--
--    Now SET NULL, with the hub and campaign NAMES snapshotted so the record
--    still reads as something after the thing it was for has gone. Two text
--    columns is the whole cost.
--
-- 3. Displaying it meant joining hub_campaigns and hubs, so an edited campaign
--    title would silently rewrite an old receipt. The snapshot fixes that too.
--
-- NOT ADDED: a status column. hub_donations only ever holds a payment Stripe
-- reported as succeeded — both writers demand it — so every row is complete by
-- construction. Inventing pending/failed states the system does not track would
-- be worse than a constant.

begin;

alter table public.hub_donations
  add column if not exists payment_method  text,
  add column if not exists hub_name        text,
  add column if not exists campaign_title  text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hub_donations_payment_method_check') then
    alter table public.hub_donations
      add constraint hub_donations_payment_method_check
      check (payment_method is null or payment_method in ('card', 'wallet'));
  end if;
end $$;

-- ── The history stops being deletable ───────────────────────────────────────
alter table public.hub_donations alter column campaign_id drop not null;
alter table public.hub_donations alter column hub_id      drop not null;

alter table public.hub_donations drop constraint if exists hub_donations_campaign_id_fkey;
alter table public.hub_donations
  add constraint hub_donations_campaign_id_fkey
  foreign key (campaign_id) references public.hub_campaigns(id) on delete set null;

alter table public.hub_donations drop constraint if exists hub_donations_hub_id_fkey;
alter table public.hub_donations
  add constraint hub_donations_hub_id_fkey
  foreign key (hub_id) references public.hubs(id) on delete set null;

-- ── Backfill, only where the evidence is conclusive ─────────────────────────
--
-- The names come from the rows they already point at, which is not a guess.
-- The payment method comes from the reference our own code wrote: 'pi_…' is
-- written only by confirm-hub-donation and the Stripe webhook, both of which
-- require a succeeded PaymentIntent; 'wallet_…' is written only by
-- wallet-checkout against its own transaction id.
--
-- Rows with NO reference are seeded demo data from before any of this existed.
-- There is nothing authoritative to say how they were paid, so they are left
-- null and the screens show nothing rather than a guess.

update public.hub_donations d
   set hub_name       = h.name
  from public.hubs h
 where h.id = d.hub_id and d.hub_name is null;

update public.hub_donations d
   set campaign_title = c.title
  from public.hub_campaigns c
 where c.id = d.campaign_id and d.campaign_title is null;

update public.hub_donations
   set payment_method = case
         when stripe_payment_intent_id like 'pi\_%'     then 'card'
         when stripe_payment_intent_id like 'wallet\_%' then 'wallet'
         else null
       end
 where payment_method is null and stripe_payment_intent_id is not null;

-- ── The writers record it from now on ───────────────────────────────────────

create or replace function public.record_hub_donation(
  p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer,
  p_message text, p_anon boolean, p_pi text, p_gift_aid boolean,
  p_title text, p_first text, p_last text, p_address text, p_postcode text
) returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_hub_name  text;
  v_camp_name text;
  v_method    text;
begin
  select name  into v_hub_name  from public.hubs           where id = p_hub;
  select title into v_camp_name from public.hub_campaigns  where id = p_campaign;
  v_method := case
    when p_pi like 'wallet\_%' then 'wallet'
    when p_pi is not null      then 'card'
    else null
  end;

  insert into public.hub_donations (
    campaign_id, hub_id, donor_user_id, amount_pence, fee_pence, message, is_anonymous,
    stripe_payment_intent_id, gift_aid, ga_title, ga_first_name, ga_last_name, ga_address, ga_postcode,
    payment_method, hub_name, campaign_title
  ) values (
    p_campaign, p_hub, p_user, p_amount, p_fee, p_message, coalesce(p_anon, false),
    p_pi, coalesce(p_gift_aid, false), p_title, p_first, p_last, p_address, p_postcode,
    v_method, v_hub_name, v_camp_name
  )
  on conflict (stripe_payment_intent_id) do nothing;

  if found then
    update public.hub_campaigns
       set raised_pence = raised_pence + p_amount,
           donor_count  = donor_count + 1
     where id = p_campaign;
  end if;
end;
$$;

revoke all on function public.record_hub_donation(uuid, uuid, uuid, integer, integer, text, boolean, text, boolean, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_hub_donation(uuid, uuid, uuid, integer, integer, text, boolean, text, boolean, text, text, text, text, text)
  to service_role;

create or replace function public.fulfil_hub_donation(
  p_pi      text,
  p_attempt uuid,
  p_user    uuid default null
)
returns table (recorded boolean, already boolean, reason text)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  a public.hub_donation_attempts%rowtype;
  v_hub_name  text;
  v_camp_name text;
begin
  if p_pi is null or btrim(p_pi) = '' then
    raise exception 'fulfil_hub_donation: payment intent id is required';
  end if;

  if exists (select 1 from public.hub_donations where stripe_payment_intent_id = p_pi) then
    return query select false, true, 'already_recorded';
    return;
  end if;

  if p_attempt is null then
    return query select false, false, 'no_attempt';
    return;
  end if;

  select * into a from public.hub_donation_attempts where id = p_attempt for update;
  if not found then
    return query select false, false, 'attempt_not_found';
    return;
  end if;
  if a.payment_intent_id is distinct from p_pi then
    return query select false, false, 'attempt_pi_mismatch';
    return;
  end if;
  if p_user is not null and a.donor_user_id <> p_user then
    return query select false, false, 'not_donor';
    return;
  end if;

  select name  into v_hub_name  from public.hubs          where id = a.hub_id;
  select title into v_camp_name from public.hub_campaigns where id = a.campaign_id;

  -- Eligibility is NOT re-checked. The attempt passed it before the payment was
  -- taken; a campaign that ended in the meantime must not turn a completed
  -- charge into a donation that never happened.
  insert into public.hub_donations (
    campaign_id, hub_id, donor_user_id, amount_pence, fee_pence, message, is_anonymous,
    stripe_payment_intent_id, gift_aid, ga_title, ga_first_name, ga_last_name, ga_address, ga_postcode,
    payment_method, hub_name, campaign_title
  ) values (
    a.campaign_id, a.hub_id, a.donor_user_id, a.face_pence, a.fee_pence, a.message, a.is_anonymous,
    p_pi, a.gift_aid, a.ga_title, a.ga_first_name, a.ga_last_name, a.ga_address, a.ga_postcode,
    a.method, v_hub_name, v_camp_name
  )
  on conflict (stripe_payment_intent_id) do nothing;

  if not found then
    return query select false, true, 'already_recorded';
    return;
  end if;

  update public.hub_campaigns
     set raised_pence = raised_pence + a.face_pence,
         donor_count  = donor_count + 1
   where id = a.campaign_id;

  update public.hub_donation_attempts
     set status = 'consumed', consumed_at = now()
   where id = a.id;

  return query select true, false, 'recorded';
end;
$$;

revoke all on function public.fulfil_hub_donation(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fulfil_hub_donation(text, uuid, uuid) to service_role;

-- ── The traps ───────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  -- The public donor wall must not have gained a column while we were here.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname='get_campaign_donors'
     and pg_get_functiondef(p.oid) like '%donor_user_id,%';
  if n > 0 then
    raise exception 'Paygate 6: get_campaign_donors would expose donor_user_id';
  end if;

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.hub_donations'::regclass and contype = 'f'
       and pg_get_constraintdef(oid) ilike '%on delete cascade%'
  ) then
    raise exception 'Paygate 6: a hub_donations foreign key still cascades — financial history would be deletable';
  end if;
end $$;

commit;
