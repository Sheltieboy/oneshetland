-- Rollback for 20261127000000_canonical_geography_foundation.
-- Nothing else references these objects (Stage 2A wires nothing), so this removes exactly what the migration added.
-- Refuses if any content table has been pointed at the new tables since (it checks for foreign keys into them).
begin;
do $$
begin
  if exists (select 1 from pg_constraint where contype = 'f' and confrelid in ('public.areas'::regclass, 'public.place_aliases'::regclass, 'public.geography_review'::regclass)
             and conrelid not in ('public.areas'::regclass, 'public.place_aliases'::regclass, 'public.geography_review'::regclass)) then
    raise exception 'rollback refused: a table outside the geography layer references it';
  end if;
end $$;
drop function if exists public.resolve_geography(text);
drop table if exists public.geography_review;
drop table if exists public.place_aliases;
drop table if exists public.areas;
drop function if exists public.tg_place_aliases_validate();
drop function if exists public.tg_areas_validate();
drop function if exists public.tg_geo_touch();
drop function if exists public.geo_normalise(text);
commit;
