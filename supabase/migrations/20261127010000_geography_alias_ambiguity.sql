-- Geography Stage 2 (follow-up to 20261127000000) - aliases may legitimately name more than one place.
--
-- The foundation made alias_normalised globally unique among active rows, which cannot express a name that refers to several places
-- (e.g. the SIC "Isles", or a village name shared by two places). Here:
--   * uniqueness becomes (normalised alias, kind, target): the same spelling may point at several targets, but never twice at the same one;
--   * resolve_geography() NEVER chooses between targets: two or more active, different meanings => status "ambiguous" with every candidate;
--   * "Isles" (SIC community-council wording spanning two canonical areas) is re-expressed as two targets instead of a hand-written ambiguous row;
--   * geography_area() / geography_locality() let any client fetch a canonical record and its Level 1 parent through one contract.
-- ADDITIVE to reference data created in the previous migration. No content table is touched.

begin;

drop index public.place_aliases_active_uq;
create unique index place_aliases_alias_target_uq on public.place_aliases (alias_normalised, kind, coalesce(area_id, '')) where is_active;
create index place_aliases_lookup_idx on public.place_aliases (alias_normalised) where is_active;

-- "Isles": two plausible canonical areas -> two target rows (the resolver reports ambiguity itself).
update public.place_aliases set is_active = false, notes = coalesce(notes, '') || ' [superseded by two-target rows in the Stage 2 follow-up]'
 where alias_normalised = 'isles' and kind = 'ambiguous' and is_active;
insert into public.place_aliases (alias, kind, area_id, confidence, source, notes) values
  ('Isles', 'area', 'yell_unst_fetlar', 'high', 'SIC community-council list', 'SIC "Isles" spans two canonical areas; with the next row this alias is AMBIGUOUS by design.'),
  ('Isles', 'area', 'whalsay_skerries', 'high', 'SIC community-council list', 'SIC "Isles" spans two canonical areas; with the previous row this alias is AMBIGUOUS by design.');

create or replace function public.resolve_geography(p_input text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $f$
declare
  n text := public.geo_normalise(p_input);
  rows_ public.place_aliases[];
  al public.place_aliases;
  ar public.areas%rowtype;
  v_loc text;
  v_targets text[];
  v_cands text[];
  out jsonb := jsonb_build_object('input', p_input, 'normalised', n, 'status', 'unresolved', 'reason', 'no_match',
                                  'area_id', null, 'locality_id', null, 'area_type', null, 'is_shetland_wide', false,
                                  'confidence', null, 'kind', null, 'alias_id', null, 'candidate_ids', '[]'::jsonb);
begin
  if n = '' then return out || jsonb_build_object('reason', 'empty'); end if;
  select array_agg(a order by a.id) into rows_ from public.place_aliases a where a.alias_normalised = n and a.is_active;
  if rows_ is null then return out; end if;

  -- All distinct targets this spelling can mean (explicit candidates of ambiguous rows included).
  select coalesce(array_agg(distinct t order by t), '{}') into v_cands
    from (select unnest(a.candidate_ids) t from unnest(rows_) a
          union select a.area_id from unnest(rows_) a where a.area_id is not null) s where t is not null;

  -- An explicit "ambiguous" row, several different meanings, or a place mixed with a non-geographic/invalid meaning: NEVER choose.
  if exists (select 1 from unnest(rows_) a where a.kind = 'ambiguous')
     or (select count(distinct (a.kind || ':' || coalesce(a.area_id, ''))) from unnest(rows_) a) > 1 then
    return out || jsonb_build_object('status', 'ambiguous', 'reason', case when cardinality(rows_) > 1 then 'multiple_targets' else 'ambiguous_alias' end,
                                     'candidate_ids', to_jsonb(v_cands), 'kind', 'ambiguous');
  end if;

  al := rows_[1];
  out := out || jsonb_build_object('kind', al.kind, 'alias_id', al.id, 'confidence', al.confidence);
  if al.kind = 'non_geographic' then
    return out || jsonb_build_object('status', 'non_geographic', 'reason', 'work_context_not_geography');
  elsif al.kind = 'invalid' then
    return out || jsonb_build_object('status', 'invalid', 'reason', 'invalid_or_test_value');
  elsif al.kind = 'unspecified' then
    return out || jsonb_build_object('status', 'unresolved', 'reason', 'unspecified_within_shetland');
  end if;

  select * into ar from public.areas where id = al.area_id;
  if not found or not ar.is_active then
    return out || jsonb_build_object('reason', 'area_inactive_or_pending', 'candidate_ids', jsonb_build_array(al.area_id));
  end if;
  v_loc := case when ar.type = 'locality' then ar.id when ar.type = 'shetland' then null else ar.parent_id end;
  out := out || jsonb_build_object('area_id', ar.id, 'area_type', ar.type, 'locality_id', v_loc, 'is_shetland_wide', ar.id = 'shetland_wide');
  if al.confidence = 'high' and ar.confidence = 'high' then
    return out || jsonb_build_object('status', 'resolved', 'reason', 'exact_alias');
  end if;
  return out || jsonb_build_object('status', 'unresolved', 'reason', 'confidence_below_high', 'area_id', null, 'locality_id', null,
                                   'is_shetland_wide', false, 'candidate_ids', jsonb_build_array(ar.id));
end;
$f$;

-- Fetch one canonical record (active only; a pending place such as Foula is not returned) with its Level 1 parent.
create function public.geography_area(p_id text)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $f$
  select jsonb_build_object(
           'id', a.id, 'slug', a.slug, 'name_official', a.name_official, 'name_display', a.name_display, 'type', a.type, 'parent_id', a.parent_id,
           'locality_id', case when a.type = 'locality' then a.id when a.type = 'shetland' then null else a.parent_id end,
           'is_physical', a.is_physical, 'is_shetland_wide', a.id = 'shetland_wide', 'confidence', a.confidence, 'boundary_ref', a.boundary_ref)
    from public.areas a where a.id = p_id and a.is_active;
$f$;

create function public.geography_locality(p_id text)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $f$
  select case when a.type = 'locality' then a.id when a.type = 'shetland' then null else a.parent_id end
    from public.areas a where a.id = p_id and a.is_active;
$f$;

revoke all on function public.geography_area(text), public.geography_locality(text) from public;
grant execute on function public.geography_area(text), public.geography_locality(text) to anon, authenticated, service_role;

commit;
