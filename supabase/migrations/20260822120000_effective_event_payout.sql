-- One authoritative answer to "can this event sell tickets, and where does the
-- money go?"
--
-- WHAT WAS WRONG
--
-- The mobile event screen decided whether to show a Buy button with:
--
--     const payoutReady = !!(event.business as any)?.payout_enabled;
--
-- That asks only whether the BUSINESS has its own connected Stripe account. The
-- product model — stated in the Payments & banking screen — is that a business
-- inherits its owner's central card and bank unless it is explicitly given its
-- own. So an organiser with a perfectly good central Connect account, running an
-- event through a business that inherits it, saw "Tickets coming soon".
--
-- create-event-ticket-intent ALREADY resolved this correctly: business account
-- if it has one, otherwise the owner's. The server would have taken the money
-- happily. Only the client's gate never learned the rule, so the sale was
-- refused by the button rather than by the backend.
--
-- WHY THIS HAS TO LIVE IN THE DATABASE
--
-- The gate cannot be computed in the client. profiles RLS is own-row-only, so a
-- BUYER cannot read the organiser's payout state at all — no amount of client
-- logic can see it. A SECURITY DEFINER function can, and hands back a single
-- boolean.
--
-- TWO FUNCTIONS, ONE RULE
--
-- event_payout_ready(uuid)       → boolean. Safe for anyone: says whether the
--                                  event can sell, and nothing else. No Stripe
--                                  identifier ever reaches a client.
-- event_payout_destination(uuid) → the resolved account id, service_role only,
--                                  for the Edge Function that actually creates
--                                  the PaymentIntent.
--
-- Both read the same private helper, so the button and the charge can never
-- disagree about who is being paid.

begin;

-- The rule, in one place. Returns the destination account (NULL when there is
-- none) and whether this is a demo organiser, for whom test-mode charges go to
-- the platform directly rather than to a connected account.
create or replace function public._event_payout_resolve(p_event_id uuid)
returns table (account_id text, is_demo boolean, all_free boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event   public.events%rowtype;
  v_acct    text := null;
  v_demo    boolean := false;
  v_free    boolean := false;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then
    return query select null::text, false, false;
    return;
  end if;

  -- A wholly free event needs no payout route at all; the Edge Function only
  -- demands one when there is money to move.
  select coalesce(bool_and(t.price_pence = 0), false)
    into v_free
    from public.event_ticket_types t
   where t.event_id = p_event_id and t.is_active;

  if v_event.organiser_hub_id is not null then
    select case when h.payout_enabled and h.stripe_account_id is not null
                then h.stripe_account_id else null end,
           coalesce(h.slug, '') like 'demo-%'
      into v_acct, v_demo
      from public.hubs h
     where h.id = v_event.organiser_hub_id;

  elsif v_event.organiser_business_id is not null then
    declare v_owner uuid; v_own boolean; v_biz_ok boolean;
    begin
      select b.owner_id,
             coalesce(b.use_business_payout, false),
             (b.payout_enabled and b.stripe_account_id is not null),
             coalesce(b.slug, '') like 'demo-%'
        into v_owner, v_own, v_biz_ok, v_demo
        from public.local_businesses b
       where b.id = v_event.organiser_business_id;

      -- The business overrides only when it has BEEN GIVEN its own payout
      -- account and that account works. use_business_payout is the explicit
      -- switch the business settings screen writes.
      if v_own and v_biz_ok then
        select b.stripe_account_id into v_acct
          from public.local_businesses b where b.id = v_event.organiser_business_id;
      else
        -- Inherit the owner's central account. It may sit on profiles, or on
        -- driver_profiles where the Fetch driver onboarding historically wrote
        -- it — the same coalesce the Payments & banking screen already does.
        select coalesce(
                 case when p.stripe_payouts_enabled and p.stripe_account_id is not null
                      then p.stripe_account_id end,
                 case when d.stripe_payouts_enabled and d.stripe_account_id is not null
                      then d.stripe_account_id end)
          into v_acct
          from public.profiles p
          left join public.driver_profiles d on d.id = p.id
         where p.id = v_owner;
      end if;
    end;
  end if;

  return query select v_acct, coalesce(v_demo, false), coalesce(v_free, false);
end;
$$;

-- Safe for any viewer: a single boolean, no identifiers.
create or replace function public.event_payout_ready(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.all_free or r.is_demo or r.account_id is not null
    from public._event_payout_resolve(p_event_id) r;
$$;

-- Returns a raw Stripe account id, so it is server-only.
create or replace function public.event_payout_destination(p_event_id uuid)
returns table (account_id text, is_demo boolean, all_free boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.account_id, r.is_demo, r.all_free from public._event_payout_resolve(p_event_id) r;
$$;

-- The private helper and the destination lookup both hand back an acct_ id, so
-- neither may be reachable by a client. Only the boolean is public.
revoke all on function public._event_payout_resolve(uuid)     from public, anon, authenticated;
revoke all on function public.event_payout_destination(uuid)  from public, anon, authenticated;
revoke all on function public.event_payout_ready(uuid)        from public;
grant execute on function public._event_payout_resolve(uuid)    to service_role;
grant execute on function public.event_payout_destination(uuid) to service_role;
grant execute on function public.event_payout_ready(uuid)       to anon, authenticated, service_role;

commit;
