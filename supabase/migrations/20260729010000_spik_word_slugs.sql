-- ============================================================================
-- Spik: word-based slugs instead of numeric IDs in the web URL.
--
-- /spik/12539 → /spik/mirry-begyit. The slug goes IN the URL so each dialect
-- word page ranks for that word. Backfilled from the word; the 3 natural
-- collisions (een, eenoo, t) are disambiguated by appending the id. New words
-- get a unique slug automatically via a trigger, so the add-a-word flow keeps
-- working untouched. (The app keeps using ids internally — not a public URL.)
-- ============================================================================

alter table public.spik_dictionary add column if not exists slug text;

-- Backfill: slugify(word).
update public.spik_dictionary
  set slug = trim(both '-' from lower(regexp_replace(coalesce(word, ''), '[^a-zA-Z0-9]+', '-', 'g')))
  where slug is null;

-- Disambiguate duplicate slugs: keep the lowest id's slug, suffix the rest with -<id>.
with d as (
  select id, slug, row_number() over (partition by slug order by id) as rn
  from public.spik_dictionary
)
update public.spik_dictionary s
  set slug = s.slug || '-' || s.id
  from d where d.id = s.id and d.rn > 1;

-- Any empty (word had no alphanumerics) gets a stable fallback.
update public.spik_dictionary set slug = 'word-' || id where slug is null or slug = '';

create unique index if not exists spik_dictionary_slug_key on public.spik_dictionary (slug);

-- New rows get a unique slug from their word automatically.
create or replace function public.tg_spik_slug() returns trigger
  language plpgsql set search_path = public as $$
declare base text; s text; n int := 1;
begin
  if new.slug is not null and new.slug <> '' then return new; end if;
  base := trim(both '-' from lower(regexp_replace(coalesce(new.word, ''), '[^a-zA-Z0-9]+', '-', 'g')));
  if base = '' then base := 'word'; end if;
  s := base;
  while exists (select 1 from public.spik_dictionary where slug = s) loop
    n := n + 1; s := base || '-' || n;
  end loop;
  new.slug := s;
  return new;
end $$;
drop trigger if exists spik_slug on public.spik_dictionary;
create trigger spik_slug before insert on public.spik_dictionary
  for each row execute function public.tg_spik_slug();
