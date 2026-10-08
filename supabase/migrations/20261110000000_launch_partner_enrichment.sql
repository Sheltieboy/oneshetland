-- ═══════════════════════════════════════════════════════════════════════════
-- Launch-partner ENRICHMENT — a read-only directory reader and an admin-only provenance log
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. A launch partner is often a sparse, unclaimed, Free, not-publicly-listed Directory record. Preparing a private
-- preview for it needs (a) to READ that record even though it is not publicly listed, and (b) somewhere to keep where a
-- machine-proposed draft came from. This migration adds exactly those two things and nothing else.
--
--   1. admin_launch_partner_directory_records(uuid[])   STABLE, read-only, admin-only.
--        Returns the few Directory fields a draft is built from, for up to 25 businesses, WHETHER OR NOT the business is
--        publicly listed (an administrator cannot otherwise read an inactive row: the table's only read policy is
--        "active and not hidden, or you own it"). It returns NO owner, NO e-mail, NO phone, NO plan, NO counts.
--
--   2. launch_partner_enrichment_runs                    append-only log, one row per enrichment attempt.
--        What was read (pages, with status), which pictures were verified, what the proposal was, what was dropped for
--        lacking evidence, what Darren should check, whether the attempt applied or failed, and a hash of the draft as
--        it stood right after it applied — so a later regeneration can tell whether a person has edited it since.
--        No client role has any privilege on it; it is reached only through the two functions below.
--
--   3. admin_launch_partner_enrichment_record(uuid, jsonb) -> jsonb   admin-only, INSERTS one run row. Nothing else.
--      admin_launch_partner_enrichment_list(uuid)           -> jsonb   admin-only, newest first, at most 10.
--
-- WHAT THIS MIGRATION DOES NOT DO, AND MUST NOT:
--   · It never writes local_businesses, products, services, offers, passes, claims, invitations, grants or any
--     publication state. The only table it creates or writes is launch_partner_enrichment_runs.
--   · It changes no existing function (admin_launch_partner_update's whitelist is untouched).
--   · No network call (no pg_net / http) anywhere in this file.
--   · The machine-proposed draft itself is written through the EXISTING admin_launch_partner_update, into the campaign's
--     private preview_config / page_config — exactly where an administrator's own edits already go.

begin;

-- ── 1. the read-only record reader ──────────────────────────────────────────
create or replace function public.admin_launch_partner_directory_records(p_ids uuid[])
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can read directory records for launch partners' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'Give at least one business id' using errcode = '22023';
  end if;
  if cardinality(p_ids) > 25 then
    raise exception 'At most 25 business ids at a time' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', b.id, 'name', b.name, 'category', b.category, 'description', b.description,
             'address', b.address, 'locality', public.business_locality(b.address),
             'logo_url', b.logo_url, 'cover_url', b.cover_url, 'website', b.website,
             'tags', to_jsonb(coalesce(b.tags, '{}'::text[]))
           ) order by b.name)
      from public.local_businesses b
     where b.id = any (p_ids)
  ), '[]'::jsonb);
end;
$$;

-- ── 2. the provenance log ───────────────────────────────────────────────────
create table if not exists public.launch_partner_enrichment_runs (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.launch_partner_campaigns(id) on delete restrict,
  run_no        integer not null check (run_no >= 1),
  status        text not null check (status in ('applied', 'failed')),
  -- 'first' = the first pass; 'regenerate' = an explicit later pass; 'retry' = a pass after a failed one.
  mode          text not null check (mode in ('first', 'regenerate', 'retry')),
  source_url    text check (source_url is null or (char_length(source_url) <= 2048 and source_url ~ '^https://')),
  -- true only when an explicit "replace my edits" confirmation was given.
  overwrote_edits boolean not null default false,
  model         text check (model is null or char_length(model) <= 120),
  pages         jsonb not null default '[]'::jsonb  check (jsonb_typeof(pages) = 'array'    and octet_length(pages::text) <= 65536),
  images        jsonb not null default '[]'::jsonb  check (jsonb_typeof(images) = 'array'   and octet_length(images::text) <= 65536),
  proposal      jsonb not null default '{}'::jsonb  check (jsonb_typeof(proposal) = 'object' and octet_length(proposal::text) <= 131072),
  dropped       jsonb not null default '[]'::jsonb  check (jsonb_typeof(dropped) = 'array'  and octet_length(dropped::text) <= 65536),
  flags         jsonb not null default '[]'::jsonb  check (jsonb_typeof(flags) = 'array'    and octet_length(flags::text) <= 16384),
  -- sha-256 of the campaign's preview_config + page_config right after this run applied it (null when it failed).
  applied_hash  text check (applied_hash is null or applied_hash ~ '^[0-9a-f]{64}$'),
  error_code    text check (error_code is null or char_length(error_code) <= 60),
  error_detail  text check (error_detail is null or char_length(error_detail) <= 600),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (campaign_id, run_no)
);

create index if not exists launch_partner_enrichment_runs_campaign_idx
  on public.launch_partner_enrichment_runs (campaign_id, run_no desc);

alter table public.launch_partner_enrichment_runs enable row level security;
revoke all on public.launch_partner_enrichment_runs from public, anon, authenticated;
grant all on public.launch_partner_enrichment_runs to service_role;
-- No policy, deliberately: reached only through the functions below.

-- Append-only: a recorded attempt is history, not a working copy.
create or replace function public._launch_partner_enrichment_immutable()
  returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Enrichment runs are append-only' using errcode = '55000';
end;
$$;
drop trigger if exists launch_partner_enrichment_no_update on public.launch_partner_enrichment_runs;
create trigger launch_partner_enrichment_no_update
  before update or delete on public.launch_partner_enrichment_runs
  for each row execute function public._launch_partner_enrichment_immutable();
drop trigger if exists launch_partner_enrichment_no_truncate on public.launch_partner_enrichment_runs;
create trigger launch_partner_enrichment_no_truncate
  before truncate on public.launch_partner_enrichment_runs
  for each statement execute function public._launch_partner_enrichment_immutable();

-- ── 3. record / list ────────────────────────────────────────────────────────
create or replace function public.admin_launch_partner_enrichment_record(p_campaign_id uuid, p_run jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_c   public.launch_partner_campaigns;
  v_no  integer;
  v_id  uuid;
  k     text;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can record an enrichment run' using errcode = '42501';
  end if;
  if p_run is null or jsonb_typeof(p_run) <> 'object' then
    raise exception 'The run must be a JSON object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_run) loop
    if k not in ('status', 'mode', 'source_url', 'overwrote_edits', 'model', 'pages', 'images', 'proposal',
                 'dropped', 'flags', 'applied_hash', 'error_code', 'error_detail') then
      raise exception 'Field "%" is not part of a run', k using errcode = '22023';
    end if;
  end loop;

  -- Serialise runs for one campaign so run_no is gap-free and two admins cannot collide.
  select * into v_c from public.launch_partner_campaigns where id = p_campaign_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  select coalesce(max(run_no), 0) + 1 into v_no from public.launch_partner_enrichment_runs where campaign_id = p_campaign_id;

  insert into public.launch_partner_enrichment_runs
    (campaign_id, run_no, status, mode, source_url, overwrote_edits, model, pages, images, proposal, dropped, flags,
     applied_hash, error_code, error_detail)
  values
    (p_campaign_id, v_no,
     p_run->>'status', p_run->>'mode', nullif(p_run->>'source_url', ''),
     coalesce((p_run->>'overwrote_edits')::boolean, false), nullif(p_run->>'model', ''),
     coalesce(p_run->'pages', '[]'::jsonb), coalesce(p_run->'images', '[]'::jsonb), coalesce(p_run->'proposal', '{}'::jsonb),
     coalesce(p_run->'dropped', '[]'::jsonb), coalesce(p_run->'flags', '[]'::jsonb),
     nullif(p_run->>'applied_hash', ''), nullif(p_run->>'error_code', ''), left(nullif(p_run->>'error_detail', ''), 600))
  returning id into v_id;

  -- A line in the campaign's audit trail: ids and counts only, never the page text or the proposal.
  perform public._launch_partner_event(
    p_campaign_id, case when p_run->>'status' = 'applied' then 'enriched' else 'enrichment_failed' end,
    jsonb_build_object('run', v_no, 'mode', p_run->>'mode',
                       'pages', jsonb_array_length(coalesce(p_run->'pages', '[]'::jsonb)),
                       'overwrote_edits', coalesce((p_run->>'overwrote_edits')::boolean, false)),
    null);
  return jsonb_build_object('id', v_id, 'run_no', v_no);
end;
$$;

create or replace function public.admin_launch_partner_enrichment_list(p_campaign_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can read enrichment runs' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) - 'created_by' order by r.run_no desc)
      from (select * from public.launch_partner_enrichment_runs where campaign_id = p_campaign_id order by run_no desc limit 10) r
  ), '[]'::jsonb);
end;
$$;

-- ── 4. grants ───────────────────────────────────────────────────────────────
revoke all on function
  public.admin_launch_partner_directory_records(uuid[]),
  public.admin_launch_partner_enrichment_record(uuid, jsonb),
  public.admin_launch_partner_enrichment_list(uuid),
  public._launch_partner_enrichment_immutable()
  from public, anon, authenticated;

-- The admin functions self-gate on launch_plan_authorised(); anon cannot even execute them.
grant execute on function
  public.admin_launch_partner_directory_records(uuid[]),
  public.admin_launch_partner_enrichment_record(uuid, jsonb),
  public.admin_launch_partner_enrichment_list(uuid)
  to authenticated, service_role;

commit;
