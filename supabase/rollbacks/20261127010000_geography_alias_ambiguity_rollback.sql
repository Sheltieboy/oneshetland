-- Rollback for 20261127010000_geography_alias_ambiguity. Restores the single-meaning alias index, removes the two-target "Isles" rows,
-- re-activates the explicit ambiguous "Isles" row, and drops the fetch helpers. The previous resolver body is in 20261127000000.
-- Refuses while any spelling still has several active meanings other than Isles (the old unique index could not be rebuilt).
begin;
do $$ begin
  if exists (select 1 from (select alias_normalised from public.place_aliases where is_active and alias_normalised <> 'isles' group by 1 having count(*) > 1) d) then
    raise exception 'rollback refused: aliases with several active meanings exist';
  end if;
end $$;
delete from public.place_aliases where alias_normalised = 'isles' and kind = 'area';
update public.place_aliases set is_active = true where alias_normalised = 'isles' and kind = 'ambiguous';
drop index if exists public.place_aliases_alias_target_uq;
drop index if exists public.place_aliases_lookup_idx;
create unique index place_aliases_active_uq on public.place_aliases (alias_normalised) where is_active;
drop function if exists public.geography_area(text);
drop function if exists public.geography_locality(text);
commit;
-- Re-run the resolver definition from 20261127000000 to restore the single-row resolver.
