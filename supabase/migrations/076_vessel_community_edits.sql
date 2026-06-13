-- 076_vessel_community_edits.sql
-- Community corrections for Da Boats. Anyone signed in can suggest a change to a
-- single fact on a vessel (correct / add / remove). When 3 OTHER people confirm
-- it, the change is applied automatically — no admin in the loop. 3 disagrees
-- auto-rejects it. Crowd consensus can change anything, including official facts.
--
-- Facts live in admin-only tables (042), so the apply step runs in a
-- SECURITY DEFINER function that bypasses RLS. Safety comes from a hard-coded
-- column allow-list — never from trusting client input.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.vessel_edit_proposals (
  id            uuid primary key default gen_random_uuid(),
  vessel_id     uuid not null references public.vessels(id) on delete cascade,
  target_table  text not null check (target_table in
                  ('vessels','vessel_names','registrations','ownership_periods','owners','measurements')),
  target_row_id uuid,                       -- null for vessel-level fields and for 'add'
  target_column text,                       -- the column for 'edit'; null for add/remove
  action        text not null check (action in ('edit','add','remove')),
  payload       jsonb not null default '{}'::jsonb,
  current_value text,                       -- snapshot of the present value, for display
  summary       text not null,              -- human sentence, also used as the audit description
  note          text,
  proposed_by   uuid references public.profiles(id) on delete set null,
  status        text not null default 'open'
                  check (status in ('open','applied','rejected','superseded')),
  confirm_count int  not null default 0,
  dispute_count int  not null default 0,
  created_at    timestamptz not null default now(),
  applied_at    timestamptz,
  resolved_at   timestamptz
);

create index if not exists idx_vessel_edit_proposals_vessel
  on public.vessel_edit_proposals (vessel_id, status);

create table if not exists public.vessel_edit_votes (
  proposal_id uuid not null references public.vessel_edit_proposals(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  vote        text not null check (vote in ('confirm','dispute')),
  created_at  timestamptz not null default now(),
  primary key (proposal_id, user_id)
);

-- ── 2. Allow-list helpers (shared by the validation trigger and the apply step) ─

-- Returns the SQL cast type for an editable (table, column), or null if the
-- column may NOT be community-edited. This is the single source of truth.
create or replace function public.vessel_edit_col_cast(p_table text, p_column text)
returns text language sql immutable as $$
  select case
    when p_table='vessels'           and p_column='canonical_name'    then 'text'
    when p_table='vessels'           and p_column='primary_lk_number' then 'text'
    when p_table='vessels'           and p_column='built_year'        then 'int'
    when p_table='vessels'           and p_column='builder'           then 'text'
    when p_table='vessels'           and p_column='hull_material'     then 'text'
    when p_table='vessels'           and p_column='status'            then 'text'
    when p_table='vessel_names'      and p_column='name'              then 'text'
    when p_table='vessel_names'      and p_column='date_text'         then 'text'
    when p_table='vessel_names'      and p_column='start_year'        then 'int'
    when p_table='vessel_names'      and p_column='end_year'          then 'int'
    when p_table='registrations'     and p_column='registration'      then 'text'
    when p_table='registrations'     and p_column='date_text'         then 'text'
    when p_table='registrations'     and p_column='start_year'        then 'int'
    when p_table='registrations'     and p_column='end_year'          then 'int'
    when p_table='ownership_periods' and p_column='date_text'         then 'text'
    when p_table='ownership_periods' and p_column='start_year'        then 'int'
    when p_table='ownership_periods' and p_column='end_year'          then 'int'
    when p_table='ownership_periods' and p_column='notes'             then 'text'
    when p_table='owners'            and p_column='name'              then 'text'
    when p_table='owners'            and p_column='notes'             then 'text'
    when p_table='measurements'      and p_column='length_m'          then 'numeric'
    when p_table='measurements'      and p_column='tonnage'           then 'numeric'
    when p_table='measurements'      and p_column='tonnage_text'      then 'text'
    when p_table='measurements'      and p_column='engine_power_kw'   then 'numeric'
    when p_table='measurements'      and p_column='measurement_year'  then 'int'
    when p_table='measurements'      and p_column='notes'             then 'text'
    else null
  end;
$$;

-- The confidence column for a table (so an applied edit reads as 'confirmed'),
-- or null where the table has none (owners, measurements).
create or replace function public.vessel_edit_conf_col(p_table text)
returns text language sql immutable as $$
  select case p_table
    when 'vessels'           then 'identity_confidence'
    when 'vessel_names'      then 'confidence'
    when 'registrations'     then 'confidence'
    when 'ownership_periods' then 'confidence'
    else null
  end;
$$;

-- ── 3. Validation trigger — a malformed proposal can never be stored ──────────

create or replace function public.tg_validate_vessel_edit() returns trigger
language plpgsql as $$
begin
  if new.action = 'edit' then
    if new.target_column is null then
      raise exception 'edit requires a target_column';
    end if;
    if public.vessel_edit_col_cast(new.target_table, new.target_column) is null then
      raise exception 'column % is not editable on %', new.target_column, new.target_table;
    end if;
    if new.target_table <> 'vessels' and new.target_row_id is null then
      raise exception 'edit on % requires a target_row_id', new.target_table;
    end if;
  elsif new.action = 'add' then
    if new.target_table not in ('vessel_names','registrations','ownership_periods','measurements') then
      raise exception 'cannot add a row to %', new.target_table;
    end if;
  elsif new.action = 'remove' then
    if new.target_table not in ('vessel_names','registrations','ownership_periods','measurements') then
      raise exception 'cannot remove a row from %', new.target_table;
    end if;
    if new.target_row_id is null then
      raise exception 'remove requires a target_row_id';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_validate_vessel_edit_bi on public.vessel_edit_proposals;
create trigger tg_validate_vessel_edit_bi
  before insert on public.vessel_edit_proposals
  for each row execute function public.tg_validate_vessel_edit();

-- ── 4. Apply step (internal only — never called directly by clients) ──────────

create or replace function public._apply_vessel_edit(p public.vessel_edit_proposals)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cast     text;
  v_conf_col text;
  v_owner_id uuid;
  v_val      text;
begin
  if p.action = 'edit' then
    v_cast := public.vessel_edit_col_cast(p.target_table, p.target_column);
    if v_cast is null then
      raise exception 'column % is not editable on %', p.target_column, p.target_table;
    end if;
    v_val := nullif(p.payload->>'value', '');

    if p.target_table = 'vessels' then
      execute format('update public.vessels set %I = $1::%s, updated_at = now() where id = $2',
                     p.target_column, v_cast)
        using v_val, p.vessel_id;
    else
      execute format('update public.%I set %I = $1::%s where id = $2',
                     p.target_table, p.target_column, v_cast)
        using v_val, p.target_row_id;
    end if;

    -- An applied edit reads as community-confirmed.
    v_conf_col := public.vessel_edit_conf_col(p.target_table);
    if v_conf_col is not null then
      if p.target_table = 'vessels' then
        execute format('update public.vessels set %I = ''confirmed'' where id = $1', v_conf_col)
          using p.vessel_id;
      else
        execute format('update public.%I set %I = ''confirmed'' where id = $1', p.target_table, v_conf_col)
          using p.target_row_id;
      end if;
    end if;

  elsif p.action = 'add' then
    if p.target_table = 'vessel_names' then
      insert into public.vessel_names (vessel_id, name, normalised_name, date_text, confidence)
      values (p.vessel_id, p.payload->>'name',
              lower(trim(coalesce(p.payload->>'name',''))),
              nullif(p.payload->>'date_text',''), 'confirmed');

    elsif p.target_table = 'registrations' then
      insert into public.registrations (vessel_id, registration, date_text, confidence)
      values (p.vessel_id, p.payload->>'registration',
              nullif(p.payload->>'date_text',''), 'confirmed');

    elsif p.target_table = 'measurements' then
      insert into public.measurements (vessel_id, tonnage_text, length_m, notes)
      values (p.vessel_id,
              nullif(p.payload->>'tonnage_text',''),
              nullif(p.payload->>'length_m','')::numeric,
              nullif(p.payload->>'notes',''));

    elsif p.target_table = 'ownership_periods' then
      -- find-or-create the owner by normalised name, then attach the period
      insert into public.owners (name, normalised_name)
      values (p.payload->>'owner', lower(trim(coalesce(p.payload->>'owner',''))))
      on conflict (normalised_name) do update set name = excluded.name
      returning id into v_owner_id;

      insert into public.ownership_periods (vessel_id, owner_id, date_text, confidence)
      values (p.vessel_id, v_owner_id, nullif(p.payload->>'date_text',''), 'confirmed');
    end if;

  elsif p.action = 'remove' then
    execute format('delete from public.%I where id = $1', p.target_table)
      using p.target_row_id;
  end if;

  -- Audit trail — shows up in "Her story" / "How we know".
  insert into public.vessel_events (vessel_id, event_type, event_year, description, confidence)
  values (p.vessel_id, 'community_edit', extract(year from now())::int, p.summary, 'confirmed');
end;
$$;

-- Internal only: block every client role from invoking the apply step directly.
revoke all on function public._apply_vessel_edit(public.vessel_edit_proposals) from public;

-- ── 5. Vote + auto-apply RPC ──────────────────────────────────────────────────

create or replace function public.vote_vessel_edit(p_proposal uuid, p_vote text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_p       public.vessel_edit_proposals%rowtype;
  v_confirm int;
  v_dispute int;
  v_applied boolean := false;
  v_status  text;
begin
  if v_uid is null then raise exception 'You must be signed in to vote.'; end if;
  if p_vote not in ('confirm','dispute') then raise exception 'Invalid vote.'; end if;

  select * into v_p from public.vessel_edit_proposals where id = p_proposal for update;
  if not found then raise exception 'That suggestion no longer exists.'; end if;
  if v_p.status <> 'open' then
    raise exception 'That suggestion has already been %.', v_p.status;
  end if;
  if v_p.proposed_by = v_uid then
    raise exception 'You can''t vote on your own suggestion.';
  end if;

  insert into public.vessel_edit_votes (proposal_id, user_id, vote)
  values (p_proposal, v_uid, p_vote)
  on conflict (proposal_id, user_id) do update
    set vote = excluded.vote, created_at = now();

  select count(*) filter (where vote = 'confirm'),
         count(*) filter (where vote = 'dispute')
    into v_confirm, v_dispute
    from public.vessel_edit_votes where proposal_id = p_proposal;

  if v_confirm >= 3 then
    perform public._apply_vessel_edit(v_p);
    update public.vessel_edit_proposals
       set status = 'applied', applied_at = now(),
           confirm_count = v_confirm, dispute_count = v_dispute
     where id = p_proposal;

    -- Close out competing open suggestions on the very same target.
    update public.vessel_edit_proposals
       set status = 'superseded', resolved_at = now()
     where vessel_id = v_p.vessel_id
       and status = 'open'
       and id <> p_proposal
       and target_table  = v_p.target_table
       and action        = v_p.action
       and target_column is not distinct from v_p.target_column
       and target_row_id is not distinct from v_p.target_row_id;

    v_applied := true;
    v_status  := 'applied';

  elsif v_dispute >= 3 then
    update public.vessel_edit_proposals
       set status = 'rejected', resolved_at = now(),
           confirm_count = v_confirm, dispute_count = v_dispute
     where id = p_proposal;
    v_status := 'rejected';

  else
    update public.vessel_edit_proposals
       set confirm_count = v_confirm, dispute_count = v_dispute
     where id = p_proposal;
    v_status := 'open';
  end if;

  return jsonb_build_object(
    'status',        v_status,
    'confirm_count', v_confirm,
    'dispute_count', v_dispute,
    'applied',       v_applied
  );
end;
$$;

grant execute on function public.vote_vessel_edit(uuid, text) to authenticated;

-- ── 6. RLS ────────────────────────────────────────────────────────────────────

alter table public.vessel_edit_proposals enable row level security;
alter table public.vessel_edit_votes     enable row level security;

-- Proposals: anyone can read (counts/pencils show even when signed out).
create policy "vessel_edit_proposals read" on public.vessel_edit_proposals
  for select using (true);

-- Only a signed-in user may create a proposal, and only as themselves.
create policy "vessel_edit_proposals insert" on public.vessel_edit_proposals
  for insert with check (proposed_by = auth.uid() and auth.uid() is not null);

-- No client update/delete: status only ever moves via vote_vessel_edit (definer).

-- Votes: a user can read only their own (mirrors memory_reactions, 066).
-- Writes go exclusively through the RPC, which is SECURITY DEFINER.
create policy "vessel_edit_votes read own" on public.vessel_edit_votes
  for select using (user_id = auth.uid());
