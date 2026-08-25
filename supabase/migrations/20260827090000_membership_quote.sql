-- Paygate 8 — the checkout is told what it will charge, by the thing that charges.
--
-- The customer bought a membership advertised as "£10 / year" and was charged
-- £10.95. The fee was correct; nobody had shown it to them.
--
-- Showing it means the client needs the figure — and the two ways a client
-- normally gets one are both wrong here. admin_config is closed to clients
-- (correctly). A mirrored constant drifts: the app already carried
-- HUB_MEMBERSHIP_FEE_PENCE = 50, which was stale for the wallet and had never
-- been right for the card.
--
-- So the server quotes it. Same tier price, same commission rail, same
-- arithmetic the payment functions use, in one round trip — and a checkout that
-- cannot reach this cannot display a total, which is the correct failure.

begin;

create or replace function public.membership_quote(p_type uuid)
returns table (
  membership_type_id uuid,
  tier_name          text,
  hub_id             uuid,
  hub_name           text,
  period             text,
  face_pence         integer,
  fee_pence          integer,
  total_pence        integer
)
  language plpgsql
  stable
  security definer
  set search_path to 'public'
as $$
declare
  t   public.hub_membership_types%rowtype;
  h   public.hubs%rowtype;
  pct integer;
  fix integer;
  v_fee integer;
begin
  select * into t from public.hub_membership_types where id = p_type and is_active;
  if not found then
    return;                            -- no row: an unknown or inactive tier
  end if;
  select * into h from public.hubs where id = t.hub_id and is_active;
  if not found then
    return;
  end if;

  -- The same rail create-hub-membership-intent and wallet-checkout read. Kept
  -- deliberately in step with _shared/commission-config.ts: percent in basis
  -- points plus a fixed amount, floored, defaulting to 0% + 95p when unset.
  select coalesce(nullif(value, '')::int, 0) into pct
    from public.admin_config where key = 'fees.membership.percent_bps';
  select coalesce(nullif(value, '')::int, 95) into fix
    from public.admin_config where key = 'fees.membership.fixed_pence';
  pct := coalesce(pct, 0);
  fix := coalesce(fix, 95);

  -- A free tier costs nothing and carries no fee — it never reaches Stripe.
  if t.price_pence <= 0 then
    return query select t.id, t.name, h.id, h.name, t.period, 0, 0, 0;
    return;
  end if;

  v_fee := (t.price_pence * pct) / 10000 + fix;

  return query select t.id, t.name, h.id, h.name, t.period,
                      t.price_pence, v_fee, t.price_pence + v_fee;
end;
$$;

comment on function public.membership_quote(uuid) is
  'What a membership will actually cost: face price, the OneShetland fee and the total, from the same tier row and the same fees.membership.* rail both payment paths use. Exists so a checkout can DISPLAY the real total rather than mirroring a constant that drifts — the customer was shown "£10 / year" and charged £10.95. Read-only; it takes no payment and grants nothing.';

-- Readable by anyone who could see the tier: it discloses a price, which is the
-- entire point. It writes nothing and reveals nothing that is not on the page.
revoke all on function public.membership_quote(uuid) from public;
grant execute on function public.membership_quote(uuid) to anon, authenticated, service_role;

commit;
