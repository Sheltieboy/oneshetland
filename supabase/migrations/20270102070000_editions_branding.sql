-- Editions R6: simple organiser branding. A cover photograph needs a "focus point" so it crops well at every width (a phone, a tablet, a wide screen).
-- Everything else about branding (logo, one brand colour, cover photograph, name, tagline) already exists on edition_organisers and editions; the Edition design
-- system derives every other tone, the typeface and the layout from those inputs in the web app, so no further settings are stored.
-- Additive and reversible: two nullable columns, each checked, with column-level update grants like their neighbours. Nothing else is touched.

alter table public.edition_organisers
  add column if not exists cover_focus text check (cover_focus is null or cover_focus ~ '^(100|[0-9]{1,2})% (100|[0-9]{1,2})%$');
alter table public.editions
  add column if not exists cover_focus text check (cover_focus is null or cover_focus ~ '^(100|[0-9]{1,2})% (100|[0-9]{1,2})%$');

comment on column public.edition_organisers.cover_focus is 'CSS object-position for the cover photograph, e.g. "40% 30%". Set by clicking the photo in the organiser dashboard.';
comment on column public.editions.cover_focus is 'Same, for an Edition''s own cover photograph (only used when the Edition has its own cover).';

grant update (cover_focus) on public.edition_organisers to authenticated;
grant insert (cover_focus), update (cover_focus) on public.editions to authenticated;
