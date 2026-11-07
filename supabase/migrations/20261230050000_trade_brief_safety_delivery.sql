-- Get it done, Stage 1: make delivery work and stop leaking the resident's contact details.
--
-- Verified on production (rolled-back probe, 7 Nov 2026):
--   * a resident could not create match rows (no INSERT policy for authors) -> 0 matches have ever existed;
--   * a matched trade could read the resident's name/phone/email from trade_briefs BEFORE answering;
--   * a trade could UPDATE any column of its match (including brief_id).
-- This migration: (1) creates matches through one checked function, (2) removes the contact columns from every
-- client read, (3) releases contact only when the RESIDENT chooses to share it with that trade, (4) funnels trade
-- replies through a function instead of a free UPDATE. Matching/ranking itself is unchanged (still done by the app).
-- No existing row is changed.

alter table public.trade_brief_matches
  add column if not exists viewed_at timestamptz,
  add column if not exists contact_shared_at timestamptz,        -- set ONLY by the resident (share_brief_contact)
  add column if not exists interest_notified_at timestamptz,     -- resident was told a trade is interested
  add column if not exists share_notified_at timestamptz;        -- trade was told the resident shared details

-- ── privileges ──────────────────────────────────────────────────────────────────────────────────────────
revoke all on public.trade_briefs from anon;
revoke all on public.trade_brief_matches from anon;
revoke select on public.trade_briefs from authenticated;
do $do$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'trade_briefs' and column_name not in ('contact_name', 'contact_phone', 'contact_email');
  execute 'grant select (' || cols || ') on public.trade_briefs to authenticated';
end $do$;
revoke update on public.trade_brief_matches from authenticated;
drop policy if exists "trade responds to own match" on public.trade_brief_matches;

-- ── 1. the resident's job reaches trades (checked server-side) ──────────────────────────────────────────────
create or replace function public.create_brief_matches(p_brief uuid, p_business_ids uuid[]) returns uuid[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); b public.trade_briefs; v_ids uuid[];
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into b from public.trade_briefs where id = p_brief and author_id = v_uid and status = 'open' and expires_at > now();
  if not found then raise exception 'No such open job' using errcode = 'P0002'; end if;
  if p_business_ids is null or cardinality(p_business_ids) = 0 then return '{}'; end if;
  with cand as (
    select lb.id, array_position(p_business_ids, lb.id) as pos
    from public.local_businesses lb
    where lb.id = any (p_business_ids)
      and lb.is_active and lb.owner_id is not null and lb.owner_id <> v_uid        -- someone who can actually answer; never your own business
      and lb.trade_categories && b.trades
      and coalesce(lb.trade_availability, '') <> 'booked_up'
    order by pos limit 8                                                           -- the existing cap of 8
  ), ins as (
    insert into public.trade_brief_matches (brief_id, business_id, status)
    select b.id, cand.id, 'sent' from cand
    on conflict (brief_id, business_id) do nothing
    returning business_id
  )
  select coalesce(array_agg(business_id), '{}') into v_ids from ins;
  return v_ids;                                                                    -- ONLY the rows really created
end $$;

-- ── 2. a trade opens, then answers ──────────────────────────────────────────────────────────────────────────
create or replace function public.mark_trade_lead_viewed(p_match uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.trade_brief_matches m set status = 'viewed', viewed_at = now()
  from public.local_businesses lb
  where m.id = p_match and lb.id = m.business_id and lb.owner_id = auth.uid() and m.status = 'sent';
end $$;

create or replace function public.respond_to_trade_match(p_match uuid, p_response text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); m public.trade_brief_matches; v_status text;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if p_response not in ('interested', 'declined') then raise exception 'Reply must be interested or declined' using errcode = '22023'; end if;
  if p_response = 'declined' and p_reason is not null and p_reason not in ('booked_up', 'too_small', 'too_far', 'wrong_trade', 'other') then
    raise exception 'Unknown reason' using errcode = '22023';
  end if;
  select m2.* into m from public.trade_brief_matches m2 join public.local_businesses lb on lb.id = m2.business_id
   where m2.id = p_match and lb.owner_id = v_uid for update of m2;
  if not found then raise exception 'No such lead' using errcode = '42501'; end if;
  if m.status not in ('sent', 'viewed') then
    return jsonb_build_object('status', m.status, 'changed', false);               -- answered already: never silently flip it
  end if;
  if not exists (select 1 from public.trade_briefs t where t.id = m.brief_id and t.status = 'open' and t.expires_at > now()) then
    raise exception 'This job is no longer open' using errcode = 'P0001';
  end if;
  v_status := p_response;
  update public.trade_brief_matches set status = v_status, responded_at = now(),
         decline_reason = case when v_status = 'declined' then coalesce(p_reason, 'other') else null end
   where id = m.id;
  return jsonb_build_object('status', v_status, 'changed', true);                 -- NO contact details here
end $$;

-- ── 3. the RESIDENT decides who gets their details ─────────────────────────────────────────────────────────
create or replace function public.share_brief_contact(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); m public.trade_brief_matches;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select m2.* into m from public.trade_brief_matches m2 join public.trade_briefs t on t.id = m2.brief_id
   where m2.id = p_match and t.author_id = v_uid and t.status = 'open' and t.expires_at > now() for update of m2;
  if not found then raise exception 'No such job reply' using errcode = '42501'; end if;
  if m.status <> 'interested' then raise exception 'Only a trade that said it is interested can be given your details' using errcode = 'P0001'; end if;
  update public.trade_brief_matches set contact_shared_at = coalesce(contact_shared_at, now()) where id = m.id;
  return jsonb_build_object('status', 'interested', 'shared', true);
end $$;

create or replace function public.get_trade_lead_contact(p_match uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select t.contact_name, t.contact_phone, t.contact_email into r
    from public.trade_brief_matches m
    join public.local_businesses lb on lb.id = m.business_id and lb.owner_id = auth.uid()
    join public.trade_briefs t on t.id = m.brief_id
   where m.id = p_match and m.status = 'interested' and m.contact_shared_at is not null;
  if not found then return null; end if;                                           -- not shared (yet): nothing at all
  return jsonb_build_object('name', r.contact_name, 'phone', r.contact_phone, 'email', r.contact_email);
end $$;

revoke all on function public.create_brief_matches(uuid, uuid[]), public.mark_trade_lead_viewed(uuid),
  public.respond_to_trade_match(uuid, text, text), public.share_brief_contact(uuid), public.get_trade_lead_contact(uuid) from public, anon;
grant execute on function public.create_brief_matches(uuid, uuid[]), public.mark_trade_lead_viewed(uuid),
  public.respond_to_trade_match(uuid, text, text), public.share_brief_contact(uuid), public.get_trade_lead_contact(uuid) to authenticated;
