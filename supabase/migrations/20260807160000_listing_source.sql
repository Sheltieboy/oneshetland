-- Where a directory listing came from.
--
-- Until now every listing was typed in by a person. Seeding places from an
-- outside source (OpenStreetMap first, maybe Historic Environment Scotland
-- next) needs three things the table can't currently express:
--
--   1. ATTRIBUTION. OpenStreetMap is ODbL and requires credit. A listing has
--      to be able to say where it came from, or the credit can't be shown.
--   2. RE-RUNS. An importer must update the row it created last time instead
--      of inserting a second copy, hence the unique (source, source_ref).
--   3. UNDO. If a seeding run turns out to be wrong, one delete on `source`
--      removes exactly what it added and nothing a human wrote.
--
-- `source` is null for everything entered by hand, which is all 404 rows
-- currently in the table.

alter table public.local_businesses
  add column if not exists source     text,
  add column if not exists source_ref text;

comment on column public.local_businesses.source is
  'Where this listing came from — e.g. ''openstreetmap''. Null means a person entered it.';
comment on column public.local_businesses.source_ref is
  'The id in that source, e.g. ''node/123456''. Unique per source so re-imports update rather than duplicate.';

create unique index if not exists local_businesses_source_ref_uidx
  on public.local_businesses (source, source_ref)
  where source is not null;
