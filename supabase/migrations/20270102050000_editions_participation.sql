-- OneShetland Editions R4d/R4e: paid Edition participation, member pricing, waivers, offline records, refunds, disputes, reconciliation, statements.
--
-- Two dimensions stay separate: edition_links.state is the OWNER'S CONSENT (R2) and is never changed by payment. Whether an approved partner is SHOWN also depends on
-- edition_participation_ok(link), replaced here (it returned true in R2). The four public views and both public policies already call it.
-- A business keeps full control: paying never edits its listing, plan, offers or rank, and withdrawing always removes it from the Edition immediately.

create table if not exists public.edition_participation_terms (
  edition_id          uuid primary key references public.editions (id) on delete cascade,
  mode                text not null default 'free' check (mode in ('free', 'fee_required')),
  fee_pence           integer check (fee_pence is null or fee_pence between 100 and 10000000),
  vat_mode            text not null default 'none' check (vat_mode in ('none', 'inclusive', 'exclusive')),
  refund_policy       text not null default 'none' check (refund_policy in ('none', 'until_date', 'full')),
  refund_until        date,
  capacity            integer check (capacity is null or capacity > 0),
  applications_close  date,
  updated_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  constraint terms_fee check ((mode = 'fee_required') = (fee_pence is not null)),
  constraint terms_refund_date check ((refund_policy = 'until_date') = (refund_until is not null))
);

create table if not exists public.edition_participations (
  id                   uuid primary key default gen_random_uuid(),
  link_id              uuid not null unique references public.edition_links (id) on delete cascade,
  edition_id           uuid not null references public.editions (id) on delete cascade,
  business_id          uuid not null references public.local_businesses (id) on delete cascade,
  status               text not null check (status in ('awaiting_payment', 'paid', 'waived', 'member_benefit', 'refund_pending', 'refunded')),
  basis                text check (basis in ('fee', 'member_free', 'member_discount', 'organiser_waiver', 'offline_paid')),
  quoted_price_pence   integer check (quoted_price_pence is null or quoted_price_pence >= 0),
  quoted_charge_pence  integer check (quoted_charge_pence is null or quoted_charge_pence >= 0),
  discount_pence       integer not null default 0 check (discount_pence >= 0),
  payment_id           uuid references public.edition_payments (id) on delete set null,
  membership_id        uuid references public.organiser_memberships (id) on delete set null,
  waived_by            uuid references auth.users (id) on delete set null,
  waiver_note          text check (waiver_note is null or char_length(waiver_note) <= 500),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists participations_edition_idx on public.edition_participations (edition_id, status);

create table if not exists public.edition_refund_requests (
  id            uuid primary key default gen_random_uuid(),
  payment_id    uuid not null references public.edition_payments (id) on delete restrict,
  organiser_id  uuid not null references public.edition_organisers (id) on delete restrict,
  amount_pence  integer not null check (amount_pence > 0),
  reason        text not null check (char_length(btrim(reason)) between 3 and 300),
  requested_by  uuid references auth.users (id) on delete set null,
  status        text not null default 'pending' check (status in ('pending', 'submitted', 'done', 'failed')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists refund_requests_status_idx on public.edition_refund_requests (status, created_at);

create table if not exists public.edition_reconciliation_exceptions (
  id            uuid primary key default gen_random_uuid(),
  organiser_id  uuid references public.edition_organisers (id) on delete set null,
  kind          text not null check (kind in ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch', 'refund_mismatch', 'destination_mismatch', 'dispute', 'amount_refused')),
  provider_ref  text not null,
  payment_id    uuid references public.edition_payments (id) on delete set null,
  detail        jsonb not null default '{}'::jsonb,
  status        text not null default 'open' check (status in ('open', 'resolved')),
  created_at    timestamptz not null default now(),
  resolved_by   uuid references auth.users (id) on delete set null,
  resolved_at   timestamptz,
  note          text
);
create unique index if not exists recon_open_uq on public.edition_reconciliation_exceptions (kind, provider_ref) where status = 'open';

-- ── eligibility: the single commercial gate behind every public read of a partnership ──────────────────────────────

create or replace function public.edition_participation_ok(p_link uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select case
      when l.kind <> 'business' then true
      when t.edition_id is null or t.mode = 'free' then true
      else exists (select 1 from public.edition_participations p where p.link_id = l.id and p.status in ('paid', 'waived', 'member_benefit'))
    end
    from public.edition_links l left join public.edition_participation_terms t on t.edition_id = l.edition_id where l.id = p_link), false)
$$;

-- ── terms ───────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.edition_set_participation_terms(p_edition uuid, p_mode text, p_fee integer, p_vat_mode text, p_refund_policy text, p_refund_until date, p_capacity integer, p_closes date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_prev public.edition_participation_terms%rowtype;
begin
  select * into e from public.editions where id = p_edition;
  if not found or auth.uid() is null or not public.edition_org_can(e.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_mode = 'fee_required' and not public.edition_org_entitled(e.organiser_id, 'participation_fees') then raise exception 'participation fees are not included in your package' using errcode = '23514', hint = 'no_participation_entitlement'; end if;
  select * into v_prev from public.edition_participation_terms where edition_id = p_edition;
  -- Once anyone has paid, the fee and refund terms they agreed to cannot be changed under them.
  if found and exists (select 1 from public.edition_participations x where x.edition_id = p_edition and x.status in ('paid', 'awaiting_payment', 'refund_pending'))
     and (v_prev.mode, v_prev.fee_pence, v_prev.refund_policy, v_prev.refund_until, v_prev.vat_mode) is distinct from (p_mode, p_fee, p_refund_policy, p_refund_until, coalesce(p_vat_mode, 'none')) then
    raise exception 'the fee and refund terms cannot be changed once businesses have paid or started paying' using errcode = '23514', hint = 'terms_locked';
  end if;
  insert into public.edition_participation_terms (edition_id, mode, fee_pence, vat_mode, refund_policy, refund_until, capacity, applications_close, updated_by)
  values (p_edition, p_mode, case when p_mode = 'fee_required' then p_fee end, coalesce(p_vat_mode, 'none'), coalesce(p_refund_policy, 'none'), case when p_refund_policy = 'until_date' then p_refund_until end, p_capacity, p_closes, auth.uid())
  on conflict (edition_id) do update set mode = excluded.mode, fee_pence = excluded.fee_pence, vat_mode = excluded.vat_mode, refund_policy = excluded.refund_policy, refund_until = excluded.refund_until,
    capacity = excluded.capacity, applications_close = excluded.applications_close, updated_by = excluded.updated_by, updated_at = now();
  perform public.edition_audit(e.organiser_id, p_edition, 'participation_terms_set', jsonb_build_object('mode', p_mode, 'fee', p_fee));
end $$;

-- ── quote: what this business owes for this Edition right now (never client supplied) ───────────────────────────────

create or replace function public.edition_participation_quote(p_link uuid)
returns table (required boolean, base_pence integer, discount_pence integer, price_pence integer, vat_pence integer, platform_fee_pence integer, charge_pence integer, net_to_organiser_pence integer,
               basis text, vat_mode text, refund_policy text, refund_until date, tier_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; t public.edition_participation_terms%rowtype; e public.editions%rowtype; bnf record; v_disc integer := 0; v_price integer; b record; v_basis text := 'fee';
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' then return; end if;
  select * into e from public.editions where id = l.edition_id;
  if auth.uid() is null or not (public.edition_biz_owner(l.business_id) or public.edition_org_can(e.organiser_id, 'editor') or public.is_admin()) then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into t from public.edition_participation_terms where edition_id = l.edition_id;
  if not found or t.mode = 'free' then
    return query select false, 0, 0, 0, 0, 0, 0, 0, 'none'::text, 'none'::text, 'none'::text, null::date, null::text; return;
  end if;
  select * into bnf from public.edition_member_benefit(e.organiser_id, l.business_id);
  if bnf.tier_id is not null and bnf.edition_benefit = 'free' then v_disc := t.fee_pence; v_basis := 'member_free';
  elsif bnf.tier_id is not null and bnf.edition_benefit = 'percent_off' then v_disc := round(t.fee_pence * bnf.discount_percent / 100.0)::integer; v_basis := 'member_discount'; end if;
  v_price := t.fee_pence - v_disc;
  select * into b from public.edition_charge_breakdown('participation', v_price, t.vat_mode, e.organiser_id);
  return query select true, t.fee_pence, v_disc, v_price, b.vat_pence, b.platform_fee_pence, b.charge_pence, b.net_to_organiser_pence, v_basis, b.vat_mode, t.refund_policy, t.refund_until, bnf.tier_name;
end $$;

-- A member whose benefit makes it free: record it (no payment, no Stripe).
create or replace function public.edition_participation_claim_benefit(p_link uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; q record; e public.editions%rowtype; v_mem uuid;
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' or l.state <> 'approved' or not public.edition_biz_owner(l.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into q from public.edition_participation_quote(p_link);
  if not q.required then return 'not_required'; end if;
  if q.price_pence <> 0 then raise exception 'your membership does not cover the full fee; pay the member price instead' using errcode = '23514'; end if;
  select * into e from public.editions where id = l.edition_id;
  select m.id into v_mem from public.organiser_memberships m where m.organiser_id = e.organiser_id and m.business_id = l.business_id and public.edition_membership_live(m) limit 1;
  insert into public.edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence, discount_pence, membership_id)
  values (p_link, l.edition_id, l.business_id, 'member_benefit', 'member_free', 0, 0, q.discount_pence, v_mem)
  on conflict (link_id) do update set status = 'member_benefit', basis = 'member_free', quoted_price_pence = 0, quoted_charge_pence = 0, discount_pence = excluded.discount_pence, membership_id = excluded.membership_id, updated_at = now()
   where public.edition_participations.status in ('awaiting_payment', 'refunded');
  perform public.edition_audit(e.organiser_id, l.edition_id, 'participation_member_benefit', jsonb_build_object('link', p_link));
  return 'member_benefit';
end $$;

-- The owner starts paying: checks, locks in the quoted price, returns exactly what to charge.
create or replace function public.edition_participation_pay_prepare(p_link uuid, p_attempt text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; e public.editions%rowtype; t public.edition_participation_terms%rowtype; q record; v_block text; v_taken integer;
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' or not public.edition_biz_owner(l.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if l.state <> 'approved' then raise exception 'accept the invitation first' using errcode = '23514'; end if;
  select * into e from public.editions where id = l.edition_id;
  if e.status in ('suspended', 'archived') then raise exception 'this Edition is not open for new partners' using errcode = '23514'; end if;
  select * into t from public.edition_participation_terms where edition_id = l.edition_id;
  if not found or t.mode <> 'fee_required' then raise exception 'there is no fee for this Edition' using errcode = '23514'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  if t.applications_close is not null and current_date > t.applications_close then raise exception 'participation for this Edition has closed' using errcode = '23514'; end if;
  if exists (select 1 from public.edition_participations p where p.link_id = p_link and p.status in ('paid', 'waived', 'member_benefit')) then raise exception 'already covered' using errcode = '23505'; end if;
  if t.capacity is not null then
    select count(*) into v_taken from public.edition_participations p where p.edition_id = l.edition_id and p.status in ('paid', 'waived', 'member_benefit', 'awaiting_payment') and p.link_id <> p_link;
    if v_taken >= t.capacity then raise exception 'this Edition is full' using errcode = '23514'; end if;
  end if;
  if public.edition_org_role(e.organiser_id) is not null then raise exception 'you cannot pay an organiser you are part of; ask them to record it instead' using errcode = '23514', hint = 'self_payment'; end if;
  v_block := public.edition_collect_blocker(e.organiser_id);
  if v_block is not null then raise exception 'this organiser cannot take payments right now (%)', v_block using errcode = '23514', hint = v_block; end if;
  select * into q from public.edition_participation_quote(p_link);
  if q.price_pence = 0 then raise exception 'your membership covers the fee; claim it instead' using errcode = '23514', hint = 'claim_benefit'; end if;
  if q.charge_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence, discount_pence)
  values (p_link, l.edition_id, l.business_id, 'awaiting_payment', 'fee', q.price_pence, q.charge_pence, q.discount_pence)
  on conflict (link_id) do update set status = 'awaiting_payment', basis = 'fee', quoted_price_pence = excluded.quoted_price_pence, quoted_charge_pence = excluded.quoted_charge_pence, discount_pence = excluded.discount_pence, updated_at = now()
   where public.edition_participations.status in ('awaiting_payment', 'refunded');
  perform public.edition_audit(e.organiser_id, l.edition_id, 'participation_pay_started', jsonb_build_object('link', p_link));
  return jsonb_build_object('link_id', p_link, 'organiser_id', e.organiser_id, 'business_id', l.business_id, 'edition_id', l.edition_id, 'price_pence', q.price_pence, 'vat_pence', q.vat_pence,
    'platform_fee_pence', q.platform_fee_pence, 'charge_pence', q.charge_pence, 'net_to_organiser_pence', q.net_to_organiser_pence, 'vat_mode', q.vat_mode, 'attempt', p_attempt, 'edition_title', e.title);
end $$;

-- Service role: the verified payment succeeded. The amount must equal the price locked in at prepare.
create or replace function public.edition_participation_payment_succeeded(p_link uuid, p_payment_intent text, p_charge text, p_charge_pence integer, p_stripe_fee integer default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_participations%rowtype; l public.edition_links%rowtype; e public.editions%rowtype; q record; v_pay uuid; v_dup uuid;
begin
  select * into p from public.edition_participations where link_id = p_link for update;
  if not found then raise exception 'unknown participation' using errcode = 'P0002'; end if;
  select id into v_dup from public.edition_payments where stripe_payment_intent_id = p_payment_intent and stripe_invoice_id is null;
  if v_dup is not null then return 'already_recorded'; end if;
  if p.status not in ('awaiting_payment', 'refunded') then raise exception 'participation is not awaiting payment (%)', p.status using errcode = '23514'; end if;
  if p_charge_pence is distinct from p.quoted_charge_pence then raise exception 'charged amount does not match the quoted price' using errcode = '23514', hint = 'amount_mismatch'; end if;
  select * into l from public.edition_links where id = p_link; select * into e from public.editions where id = p.edition_id;
  select * into q from public.edition_charge_breakdown('participation', p.quoted_price_pence, (select t.vat_mode from public.edition_participation_terms t where t.edition_id = p.edition_id), e.organiser_id);
  v_pay := public.edition_record_payment_row(e.organiser_id, p.business_id, 'participation', p.id, 'stripe', 'succeeded', q.price_pence, q.vat_pence, q.vat_mode, q.platform_fee_pence, q.charge_pence, q.net_to_organiser_pence,
    p_payment_intent, null, p_charge, null, null, null, null, (select created_by from public.edition_links where id = p_link), null, null);
  if p_stripe_fee is not null then update public.edition_payments set stripe_fee_pence = p_stripe_fee where id = v_pay; end if;
  update public.edition_participations set status = 'paid', payment_id = v_pay, updated_at = now() where id = p.id;
  perform public.edition_audit(e.organiser_id, p.edition_id, 'participation_paid', jsonb_build_object('link', p_link, 'charge', p_charge_pence));
  return 'recorded';
end $$;

create or replace function public.edition_participation_payment_failed(p_link uuid, p_payment_intent text) returns void
language sql security definer set search_path = public, pg_temp as $$
  select public.edition_audit((select e.organiser_id from public.edition_participations p join public.editions e on e.id = p.edition_id where p.link_id = p_link), null, 'participation_payment_failed', jsonb_build_object('link', p_link, 'pi', p_payment_intent))
$$;

-- Organiser waives the fee for one partner (a reason is mandatory and audited) or records money received outside OneShetland.
create or replace function public.edition_participation_waive(p_link uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; e public.editions%rowtype;
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into e from public.editions where id = l.edition_id;
  if auth.uid() is null or not public.edition_org_can(e.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'say why the fee is waived' using errcode = '23514'; end if;
  insert into public.edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence, waived_by, waiver_note)
  values (p_link, l.edition_id, l.business_id, 'waived', 'organiser_waiver', 0, 0, auth.uid(), btrim(p_note))
  on conflict (link_id) do update set status = 'waived', basis = 'organiser_waiver', waived_by = auth.uid(), waiver_note = btrim(p_note), updated_at = now() where public.edition_participations.status in ('awaiting_payment', 'refunded');
  if not found then raise exception 'this partner is already covered' using errcode = '23505'; end if;
  perform public.edition_audit(e.organiser_id, l.edition_id, 'participation_waived', jsonb_build_object('link', p_link, 'note', p_note));
end $$;

create or replace function public.edition_participation_record_offline(p_link uuid, p_amount integer, p_method text, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; e public.editions%rowtype; v_pay uuid; v_part uuid;
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into e from public.editions where id = l.edition_id;
  if auth.uid() is null or not public.edition_org_can(e.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if not public.edition_org_entitled(e.organiser_id, 'offline_records') then raise exception 'recording offline payments is not included in your package' using errcode = '23514'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 or p_amount is null or p_amount < 0 or p_amount > 10000000 or p_method not in ('cheque', 'bank_transfer', 'cash', 'imported', 'other') then raise exception 'record the amount, how it was paid and a note' using errcode = '23514'; end if;
  if exists (select 1 from public.edition_participations x where x.link_id = p_link and x.status in ('paid', 'waived', 'member_benefit')) then raise exception 'this partner is already covered' using errcode = '23505'; end if;
  insert into public.edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence) values (p_link, l.edition_id, l.business_id, 'awaiting_payment', 'offline_paid', p_amount, p_amount)
  on conflict (link_id) do update set basis = 'offline_paid', quoted_price_pence = p_amount, quoted_charge_pence = p_amount, updated_at = now() returning id into v_part;
  v_pay := public.edition_record_payment_row(e.organiser_id, l.business_id, 'participation', v_part, 'offline', 'succeeded', p_amount, 0, 'none', 0, p_amount, p_amount, null, null, null, null, null, p_method, auth.uid(), null, btrim(p_note), null);
  update public.edition_participations set status = 'paid', payment_id = v_pay, updated_at = now() where id = v_part;
  perform public.edition_audit(e.organiser_id, l.edition_id, 'participation_recorded_offline', jsonb_build_object('link', p_link, 'amount', p_amount));
  return v_pay;
end $$;

-- ── withdrawing and refunds ─────────────────────────────────────────────────────────────────────────────────────────

-- The owner steps back from the Edition. The consent withdrawal (R2) happens first and always: the partner disappears at once. A refund is requested only if
-- the organiser's published policy allows it; otherwise nothing is owed and nothing is hidden from the owner (they are told which applies).
create or replace function public.edition_participation_withdraw(p_link uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; e public.editions%rowtype; t public.edition_participation_terms%rowtype; p public.edition_participations%rowtype; v_refundable boolean := false; v_rr uuid; v_left integer;
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' or not public.edition_biz_owner(l.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into e from public.editions where id = l.edition_id; select * into t from public.edition_participation_terms where edition_id = l.edition_id; select * into p from public.edition_participations where link_id = p_link;
  if l.state = 'approved' then perform public.edition_link_act(p_link, 'withdraw', null); end if;
  if p.id is null or p.status <> 'paid' or p.payment_id is null then
    if p.id is not null and p.status = 'awaiting_payment' then update public.edition_participations set status = 'refunded', updated_at = now() where id = p.id; end if;
    return 'withdrawn_no_payment';
  end if;
  v_refundable := case t.refund_policy when 'full' then true when 'until_date' then current_date <= t.refund_until else false end;
  if not v_refundable then return 'withdrawn_no_refund_due'; end if;
  select charge_pence - refunded_pence into v_left from public.edition_payments where id = p.payment_id;
  if p.status = 'paid' and v_left > 0 and (select source from public.edition_payments where id = p.payment_id) = 'stripe' then
    insert into public.edition_refund_requests (payment_id, organiser_id, amount_pence, reason, requested_by) values (p.payment_id, e.organiser_id, v_left, 'Withdrawn within the organiser''s refund policy', auth.uid()) returning id into v_rr;
    update public.edition_participations set status = 'refund_pending', updated_at = now() where id = p.id;
    perform public.edition_audit(e.organiser_id, l.edition_id, 'participation_refund_requested', jsonb_build_object('link', p_link, 'request', v_rr));
    return 'withdrawn_refund_requested';
  end if;
  return 'withdrawn_refund_by_organiser';
end $$;

-- Organiser or admin asks for a refund of a payment (full or partial). The provider call is made by the service function that drains the queue.
create or replace function public.edition_payment_request_refund(p_payment uuid, p_amount integer, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_payments%rowtype; v_id uuid;
begin
  select * into p from public.edition_payments where id = p_payment;
  if not found or auth.uid() is null or not (public.edition_org_can(p.organiser_id, 'admin') or public.is_admin()) then raise exception 'not found' using errcode = 'P0002'; end if;
  if p.source <> 'stripe' then raise exception 'offline and complimentary payments are corrected by recording a new entry, not refunded here' using errcode = '23514'; end if;
  if p.status not in ('succeeded', 'partially_refunded') then raise exception 'this payment cannot be refunded' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > p.charge_pence - p.refunded_pence then raise exception 'the refund must be more than nothing and no more than what is left' using errcode = '23514'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'a reason is required' using errcode = '23514'; end if;
  if exists (select 1 from public.edition_refund_requests r where r.payment_id = p_payment and r.status in ('pending', 'submitted')) then raise exception 'a refund is already in progress for this payment' using errcode = '23505'; end if;
  insert into public.edition_refund_requests (payment_id, organiser_id, amount_pence, reason, requested_by) values (p_payment, p.organiser_id, p_amount, btrim(p_reason), auth.uid()) returning id into v_id;
  perform public.edition_audit(p.organiser_id, null, 'refund_requested', jsonb_build_object('payment', p_payment, 'amount', p_amount));
  return v_id;
end $$;

create or replace function public.edition_refunds_next() returns table (request_id uuid, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text, platform_fee_pence integer, refund_application_fee boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.payment_id, r.amount_pence, p.stripe_payment_intent_id, p.stripe_charge_id, p.platform_fee_pence, public.edition_commerce_cfg('editions.commerce.refund_application_fee', 'true') = 'true'
    from public.edition_refund_requests r join public.edition_payments p on p.id = r.payment_id where r.status = 'pending' order by r.created_at limit 20
$$;
create or replace function public.edition_refund_request_mark(p_request uuid, p_status text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_refund_requests set status = p_status, resolved_at = case when p_status in ('done', 'failed') then now() end where id = p_request and status in ('pending', 'submitted') and p_status in ('submitted', 'done', 'failed')
$$;

-- Service role: the provider reports the CUMULATIVE refunded amount for a payment. Idempotent; never lowers; a full refund of the latest period ends a membership's benefits
-- and returns a participation to 'refunded' (so it leaves the public Edition) without touching the owner's consent or anything about the business.
create or replace function public.edition_payment_refunded(p_payment_intent text, p_refunded_total integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_payments%rowtype; v_full boolean;
begin
  select * into p from public.edition_payments where stripe_payment_intent_id = p_payment_intent order by created_at desc limit 1;
  if not found then
    insert into public.edition_reconciliation_exceptions (kind, provider_ref, detail) values ('missing_in_ledger', p_payment_intent, jsonb_build_object('refunded', p_refunded_total)) on conflict do nothing;
    return 'unknown_payment';
  end if;
  if p_refunded_total <= p.refunded_pence then return 'no_change'; end if;
  if p_refunded_total > p.charge_pence then
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'refund_mismatch', p_payment_intent, p.id, jsonb_build_object('refunded', p_refunded_total, 'charge', p.charge_pence)) on conflict do nothing;
    raise exception 'refund exceeds the payment' using errcode = '23514';
  end if;
  v_full := p_refunded_total >= p.charge_pence;
  update public.edition_payments set refunded_pence = p_refunded_total, status = case when v_full then 'refunded' else 'partially_refunded' end where id = p.id;
  if v_full and p.kind = 'participation' then update public.edition_participations set status = 'refunded', updated_at = now() where id = p.ref_id and payment_id = p.id; end if;
  if v_full and p.kind = 'membership' and p.id = (select x.id from public.edition_payments x where x.kind = 'membership' and x.ref_id = p.ref_id and x.status <> 'voided' order by x.created_at desc limit 1) then
    update public.organiser_memberships set status = 'cancelled', current_period_end = least(coalesce(current_period_end, now()), now()), updated_at = now() where id = p.ref_id and status in ('active', 'past_due', 'cancel_at_period_end');
  end if;
  update public.edition_refund_requests set status = 'done', resolved_at = now() where payment_id = p.id and status in ('pending', 'submitted');
  perform public.edition_audit(p.organiser_id, null, 'payment_refunded', jsonb_build_object('payment', p.id, 'total', p_refunded_total));
  return case when v_full then 'refunded' else 'partially_refunded' end;
end $$;

-- A dispute never silently changes entitlements: it marks the payment and raises an exception for the administrator.
create or replace function public.edition_payment_disputed(p_payment_intent text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_payments%rowtype;
begin
  select * into p from public.edition_payments where stripe_payment_intent_id = p_payment_intent order by created_at desc limit 1;
  if not found then
    insert into public.edition_reconciliation_exceptions (kind, provider_ref, detail) values ('dispute', p_payment_intent, jsonb_build_object('reason', p_reason)) on conflict do nothing; return;
  end if;
  if p.status in ('succeeded', 'partially_refunded') then update public.edition_payments set status = 'disputed' where id = p.id; end if;
  insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'dispute', p_payment_intent, p.id, jsonb_build_object('reason', p_reason)) on conflict do nothing;
  perform public.edition_audit(p.organiser_id, null, 'payment_disputed', jsonb_build_object('payment', p.id));
end $$;

-- A provider payment that cannot be applied (amount mismatch etc.) is recorded for the administrator instead of being lost.
create or replace function public.edition_record_exception(p_kind text, p_ref text, p_org uuid, p_detail jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, detail) values (p_org, p_kind, p_ref, coalesce(p_detail, '{}'::jsonb)) on conflict do nothing
$$;

-- ── reconciliation: compare a provider snapshot with the ledger ────────────────────────────────────────────────────

-- p_snapshot: [{ "payment_intent": "pi_..", "amount": 1000, "application_fee": 50, "refunded": 0, "destination": "acct_..", "status": "succeeded" }, ...] covering the period.
-- Raises idempotent exceptions (one open per kind+ref). Returns counts. Nothing is "fixed" automatically: an administrator resolves each with a note.
create or replace function public.edition_reconcile_apply(p_snapshot jsonb, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; p public.edition_payments%rowtype; a text; v_n int := 0; v_seen text[] := '{}'; v_pi text;
begin
  if jsonb_typeof(coalesce(p_snapshot, '[]'::jsonb)) <> 'array' then raise exception 'snapshot must be an array' using errcode = '22023'; end if;
  for s in select * from jsonb_array_elements(p_snapshot) loop
    v_pi := s ->> 'payment_intent'; v_seen := v_seen || v_pi;
    select * into p from public.edition_payments where stripe_payment_intent_id = v_pi order by created_at desc limit 1;
    if not found then
      if coalesce(s ->> 'status', 'succeeded') = 'succeeded' then insert into public.edition_reconciliation_exceptions (kind, provider_ref, detail) values ('missing_in_ledger', v_pi, s) on conflict do nothing; v_n := v_n + 1; end if;
      continue;
    end if;
    if (s ->> 'amount')::int is distinct from p.charge_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'amount_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'amount', 'ledger', p.charge_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    if s ? 'application_fee' and (s ->> 'application_fee')::int is distinct from p.platform_fee_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'fee_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'application_fee', 'ledger', p.platform_fee_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    if s ? 'refunded' and (s ->> 'refunded')::int is distinct from p.refunded_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'refund_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'refunded', 'ledger', p.refunded_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    a := public.edition_payout_account_for(p.organiser_id);
    if s ? 'destination' and (s ->> 'destination') is distinct from a then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'destination_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'destination')) on conflict do nothing; v_n := v_n + 1; end if;
  end loop;
  for p in select * from public.edition_payments x where x.source = 'stripe' and x.status in ('succeeded', 'partially_refunded', 'refunded') and x.created_at between p_from and p_to and x.stripe_payment_intent_id is not null and not (x.stripe_payment_intent_id = any (v_seen)) loop
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'missing_at_provider', p.stripe_payment_intent_id, p.id, jsonb_build_object('charge', p.charge_pence)) on conflict do nothing; v_n := v_n + 1;
  end loop;
  return jsonb_build_object('checked', jsonb_array_length(p_snapshot), 'exceptions_raised', v_n);
end $$;

create or replace function public.admin_resolve_edition_exception(p_exception uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'a note is required' using errcode = '23514'; end if;
  update public.edition_reconciliation_exceptions set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), note = btrim(p_note) where id = p_exception and status = 'open';
  if not found then raise exception 'no open exception with that id' using errcode = 'P0002'; end if;
  perform public.edition_audit(null, null, 'exception_resolved', jsonb_build_object('exception', p_exception));
end $$;

-- ── read models ─────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.edition_participation_rows(p_edition uuid)
returns table (link_id uuid, business_id uuid, business_name text, link_state text, required boolean, status text, basis text, quoted_charge_pence integer, discount_pence integer, paid_pence integer, shown boolean, waiver_note text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select l.id, l.business_id, b.name, l.state, coalesce((select t.mode = 'fee_required' from public.edition_participation_terms t where t.edition_id = p_edition), false),
    coalesce(p.status, case when coalesce((select t.mode = 'fee_required' from public.edition_participation_terms t where t.edition_id = p_edition), false) then 'not_started' else 'not_required' end),
    p.basis, p.quoted_charge_pence, p.discount_pence, (select pay.charge_pence - pay.refunded_pence from public.edition_payments pay where pay.id = p.payment_id),
    (l.state = 'approved' and public.edition_participation_ok(l.id)), p.waiver_note
    from public.edition_links l join public.local_businesses b on b.id = l.business_id left join public.edition_participations p on p.link_id = l.id
   where l.edition_id = p_edition and l.kind = 'business' and l.state in ('pending', 'approved') order by b.name;
end $$;

create or replace function public.edition_my_participations()
returns table (link_id uuid, business_id uuid, business_name text, edition_id uuid, edition_title text, edition_slug text, organiser_name text, required boolean, status text, base_pence integer, discount_pence integer,
               price_pence integer, charge_pence integer, vat_pence integer, basis text, refund_policy text, refund_until date, tier_name text, shown boolean, can_pay boolean, pay_blocker text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; q record; v_status text;
begin
  if auth.uid() is null then return; end if;
  for r in select l.id as link_id, l.business_id, b.name as bname, e.id as eid, e.title, e.slug, o.name as oname, o.id as oid, p.status as pstatus
             from public.edition_links l join public.editions e on e.id = l.edition_id join public.edition_organisers o on o.id = e.organiser_id join public.local_businesses b on b.id = l.business_id left join public.edition_participations p on p.link_id = l.id
            where l.kind = 'business' and l.state = 'approved' and public.edition_biz_owner(l.business_id) order by e.starts_on loop
    select * into q from public.edition_participation_quote(r.link_id);
    v_status := coalesce(r.pstatus, case when q.required then 'not_started' else 'not_required' end);
    return query select r.link_id, r.business_id, r.bname, r.eid, r.title, r.slug, r.oname, coalesce(q.required, false), v_status, q.base_pence, q.discount_pence, q.price_pence, q.charge_pence, q.vat_pence, q.basis, q.refund_policy, q.refund_until, q.tier_name,
      public.edition_participation_ok(r.link_id),
      (coalesce(q.required, false) and v_status in ('not_started', 'awaiting_payment', 'refunded') and q.price_pence > 0 and public.edition_collect_blocker(r.oid) is null and public.edition_org_role(r.oid) is null),
      case when coalesce(q.required, false) and v_status in ('not_started', 'awaiting_payment', 'refunded') then coalesce(public.edition_collect_blocker(r.oid), case when public.edition_org_role(r.oid) is not null then 'self_payment' end) end;
  end loop;
end $$;

create or replace function public.edition_org_payments(p_org uuid, p_from timestamptz default null, p_to timestamptz default null, p_kind text default null)
returns table (payment_id uuid, created_at timestamptz, kind text, business_name text, source text, status text, price_pence integer, vat_pence integer, platform_fee_pence integer, stripe_fee_pence integer, charge_pence integer,
               net_to_organiser_pence integer, refunded_pence integer, method text, period_start timestamptz, period_end timestamptz, note text, ref_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'admin') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select p.id, p.created_at, p.kind, b.name, p.source, p.status, p.price_pence, p.vat_pence, p.platform_fee_pence, p.stripe_fee_pence, p.charge_pence, p.net_to_organiser_pence, p.refunded_pence, p.method, p.period_start, p.period_end, p.note,
    case p.kind when 'membership' then (select t.name from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id where m.id = p.ref_id)
                else (select e.title from public.edition_participations x join public.editions e on e.id = x.edition_id where x.id = p.ref_id) end
    from public.edition_payments p join public.local_businesses b on b.id = p.business_id
   where p.organiser_id = p_org and (p_from is null or p.created_at >= p_from) and (p_to is null or p.created_at < p_to) and (p_kind is null or p.kind = p_kind) order by p.created_at desc limit 1000;
end $$;

create or replace function public.edition_my_payments()
returns table (payment_id uuid, created_at timestamptz, organiser_name text, kind text, label text, source text, status text, price_pence integer, vat_pence integer, charge_pence integer, refunded_pence integer, vat_mode text, vat_number text, legal_name text, period_end timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.created_at, o.name, p.kind,
         case p.kind when 'membership' then (select t.name from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id where m.id = p.ref_id)
                     else (select e.title from public.edition_participations x join public.editions e on e.id = x.edition_id where x.id = p.ref_id) end,
         p.source, p.status, p.price_pence, p.vat_pence, p.charge_pence, p.refunded_pence, p.vat_mode, a.vat_number, a.legal_name, p.period_end
    from public.edition_payments p join public.edition_organisers o on o.id = p.organiser_id left join public.edition_payout_accounts a on a.organiser_id = p.organiser_id
   where auth.uid() is not null and public.edition_biz_owner(p.business_id) order by p.created_at desc limit 500
$$;

-- Monthly summary (organiser: its own; admin: any). Gross, platform fee, provider fee where known, net, refunds.
create or replace function public.edition_org_statement(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (month text, payments integer, gross_pence bigint, vat_pence bigint, platform_fee_pence bigint, stripe_fee_pence bigint, net_to_organiser_pence bigint, refunded_pence bigint, offline_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'admin') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select to_char(date_trunc('month', p.created_at at time zone 'Europe/London'), 'YYYY-MM'), count(*)::int, sum(p.charge_pence) filter (where p.source = 'stripe'), sum(p.vat_pence) filter (where p.source = 'stripe'),
    sum(p.platform_fee_pence) filter (where p.source = 'stripe'), sum(p.stripe_fee_pence) filter (where p.source = 'stripe'), sum(p.net_to_organiser_pence) filter (where p.source = 'stripe'), sum(p.refunded_pence), sum(p.charge_pence) filter (where p.source = 'offline')
    from public.edition_payments p where p.organiser_id = p_org and p.created_at >= p_from and p.created_at < p_to and p.status <> 'failed' group by 1 order by 1;
end $$;

-- Platform view for the administrator: fees earned per organiser in the period.
create or replace function public.admin_edition_fee_statement(p_from timestamptz, p_to timestamptz)
returns table (organiser_id uuid, organiser_name text, payments integer, gross_pence bigint, platform_fee_pence bigint, refunded_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select o.id, o.name, count(*)::int, sum(p.charge_pence), sum(p.platform_fee_pence), sum(p.refunded_pence)
    from public.edition_payments p join public.edition_organisers o on o.id = p.organiser_id where p.source = 'stripe' and p.created_at >= p_from and p.created_at < p_to and p.status <> 'failed' group by o.id, o.name order by 5 desc;
end $$;

-- ── webhook bookkeeping, Stripe customers, helpers for the payment functions (service role only) ─────────────────────

create table if not exists public.edition_webhook_events (
  event_id     text primary key,
  event_type   text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  outcome      text check (outcome in ('ok', 'ignored', 'failed')),
  detail       text
);
create table if not exists public.edition_stripe_customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

-- true = this provider event is new (or a previous attempt failed) and should be processed; false = already handled.
create or replace function public.edition_webhook_begin(p_event text, p_type text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_out text;
begin
  insert into public.edition_webhook_events (event_id, event_type) values (p_event, p_type) on conflict do nothing;
  if found then return true; end if;
  select outcome into v_out from public.edition_webhook_events where event_id = p_event;
  return v_out = 'failed' or v_out is null;
end $$;
create or replace function public.edition_webhook_done(p_event text, p_outcome text, p_detail text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_webhook_events set processed_at = now(), outcome = p_outcome, detail = left(p_detail, 500) where event_id = p_event
$$;
create or replace function public.edition_payment_known(p_payment_intent text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.edition_payments where stripe_payment_intent_id = p_payment_intent)
$$;
create or replace function public.edition_customer_get(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$ select stripe_customer_id from public.edition_stripe_customers where user_id = p_user $$;
create or replace function public.edition_customer_set(p_user uuid, p_customer text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.edition_stripe_customers (user_id, stripe_customer_id) values (p_user, p_customer) on conflict (user_id) do nothing
$$;
alter table public.edition_webhook_events enable row level security;
alter table public.edition_stripe_customers enable row level security;
revoke all on public.edition_webhook_events, public.edition_stripe_customers from public, anon, authenticated;
do $$ declare f text; begin
  foreach f in array array['edition_webhook_begin(text,text)', 'edition_webhook_done(text,text,text)', 'edition_payment_known(text)', 'edition_customer_get(uuid)', 'edition_customer_set(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ── lock down ───────────────────────────────────────────────────────────────────────────────────────────────────────

do $$ declare t text; begin
  foreach t in array array['edition_participation_terms', 'edition_participations', 'edition_refund_requests', 'edition_reconciliation_exceptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
create policy "terms public read" on public.edition_participation_terms for select to anon, authenticated using (public.edition_is_public(edition_id));
create policy "terms team read" on public.edition_participation_terms for select to authenticated using (public.edition_can(edition_id, 'editor') or public.edition_staff());
grant select on public.edition_participation_terms to anon, authenticated;
create policy "participations team read" on public.edition_participations for select to authenticated using (public.edition_can(edition_id, 'editor') or public.is_admin());
create policy "participations owner read" on public.edition_participations for select to authenticated using (public.edition_biz_owner(business_id));
grant select on public.edition_participations to authenticated;
create policy "refund requests read" on public.edition_refund_requests for select to authenticated using (public.edition_org_can(organiser_id, 'admin') or public.is_admin());
grant select on public.edition_refund_requests to authenticated;
create policy "exceptions admin read" on public.edition_reconciliation_exceptions for select to authenticated using (public.is_admin());
grant select on public.edition_reconciliation_exceptions to authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'edition_set_participation_terms(uuid,text,integer,text,text,date,integer,date)', 'edition_participation_quote(uuid)', 'edition_participation_claim_benefit(uuid)', 'edition_participation_pay_prepare(uuid,text)',
    'edition_participation_payment_succeeded(uuid,text,text,integer,integer)', 'edition_participation_payment_failed(uuid,text)', 'edition_participation_waive(uuid,text)', 'edition_participation_record_offline(uuid,integer,text,text)',
    'edition_participation_withdraw(uuid)', 'edition_payment_request_refund(uuid,integer,text)', 'edition_refunds_next()', 'edition_refund_request_mark(uuid,text)', 'edition_payment_refunded(text,integer)',
    'edition_payment_disputed(text,text)', 'edition_record_exception(text,text,uuid,jsonb)', 'edition_reconcile_apply(jsonb,timestamptz,timestamptz)', 'admin_resolve_edition_exception(uuid,text)',
    'edition_participation_rows(uuid)', 'edition_my_participations()', 'edition_org_payments(uuid,timestamptz,timestamptz,text)', 'edition_my_payments()', 'edition_org_statement(uuid,timestamptz,timestamptz)', 'admin_edition_fee_statement(timestamptz,timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'edition_set_participation_terms(uuid,text,integer,text,text,date,integer,date)', 'edition_participation_quote(uuid)', 'edition_participation_claim_benefit(uuid)', 'edition_participation_pay_prepare(uuid,text)',
    'edition_participation_waive(uuid,text)', 'edition_participation_record_offline(uuid,integer,text,text)', 'edition_participation_withdraw(uuid)', 'edition_payment_request_refund(uuid,integer,text)',
    'admin_resolve_edition_exception(uuid,text)', 'edition_participation_rows(uuid)', 'edition_my_participations()', 'edition_org_payments(uuid,timestamptz,timestamptz,text)', 'edition_my_payments()',
    'edition_org_statement(uuid,timestamptz,timestamptz)', 'admin_edition_fee_statement(timestamptz,timestamptz)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'edition_participation_payment_succeeded(uuid,text,text,integer,integer)', 'edition_participation_payment_failed(uuid,text)', 'edition_refunds_next()', 'edition_refund_request_mark(uuid,text)', 'edition_payment_refunded(text,integer)',
    'edition_payment_disputed(text,text)', 'edition_record_exception(text,text,uuid,jsonb)', 'edition_reconcile_apply(jsonb,timestamptz,timestamptz)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
-- the public policies and views call the eligibility predicate as the visitor
revoke all on function public.edition_participation_ok(uuid) from public;
grant execute on function public.edition_participation_ok(uuid) to anon, authenticated;
