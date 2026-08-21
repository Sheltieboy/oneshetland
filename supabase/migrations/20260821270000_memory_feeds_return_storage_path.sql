-- Step 14 §17 — the memory feeds stop serving a URL that no longer resolves.
--
-- fetch_memory_pins and search_memories both selected memory_media.url as the
-- pin hero. That column holds the legacy PUBLIC object URL, written when
-- memories-media was a public bucket. Step 13C made the bucket private, so
-- every one of those URLs is now a dead 400 — the mobile map pins and memory
-- cards render them directly (components/MemoryMapNative.tsx, MemoryCard.tsx),
-- so they have been showing broken thumbnails since the cutover.
--
-- The architecture Step 13B settled on is: storage_path is the durable
-- identity, and each reader signs it for the viewer at display time. A signed
-- URL is never stored. These two feeds are the last readers that had not been
-- moved over.
--
-- hero_url is KEPT in the return shape and returned as NULL rather than being
-- dropped, so no existing client breaks on a missing field while the mobile
-- app is updated to sign hero_path. Nothing is served in it any more.
--
-- Visibility semantics are unchanged and are re-stated verbatim below: public,
-- or community to a signed-in viewer, or the author's own. This migration
-- changes only which media column is returned.
--
-- Both functions are SECURITY DEFINER and are recreated here, so search_path is
-- pinned at the same time. Every reference in both bodies is already
-- schema-qualified, so the pin changes no resolution.

begin;

-- Return type changes, so CREATE OR REPLACE cannot be used. DDL is
-- transactional: the drop and recreate land together or not at all.
drop function if exists public.fetch_memory_pins(numeric, numeric, numeric, numeric, integer);

create function public.fetch_memory_pins(
  min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric,
  result_limit integer default 500
)
returns table (
  id uuid, lat numeric, lng numeric, place_name text, title text, era text,
  tags text[], media_count integer, comment_count integer, reaction_count integer,
  child_count integer, hero_url text, hero_path text, hero_kind text,
  created_at timestamptz, author_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    m.id, m.lat, m.lng, m.place_name, m.title, m.era, m.tags,
    m.media_count, m.comment_count, m.reaction_count, m.child_count,
    null::text as hero_url,
    (select mm.storage_path from public.memory_media mm where mm.memory_id = m.id order by (mm.kind = 'photo') desc, mm.display_order limit 1) as hero_path,
    (select mm.kind         from public.memory_media mm where mm.memory_id = m.id order by (mm.kind = 'photo') desc, mm.display_order limit 1) as hero_kind,
    m.created_at, m.author_id
  from public.memories m
  where m.parent_id is null
    and not m.is_hidden
    and m.lat between min_lat and max_lat
    and m.lng between min_lng and max_lng
    and (
      m.visibility = 'public'
      or (m.visibility = 'community' and auth.uid() is not null)
      or m.author_id = auth.uid()
    )
    and not public.is_blocked_pair(auth.uid(), m.author_id)
  order by m.created_at desc
  limit result_limit;
$function$;

drop function if exists public.search_memories(text, integer);

create function public.search_memories(q text, result_limit integer default 50)
returns table (
  id uuid, lat numeric, lng numeric, place_name text, title text,
  body_excerpt text, era text, tags text[], matched_via text,
  hero_url text, hero_path text, hero_kind text, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with q_norm as (
    select lower(trim(q)) as qq
  ),
  candidates as (
    select
      m.*,
      case
        when m.title ilike '%' || (select qq from q_norm) || '%' then 'title'
        when m.body  ilike '%' || (select qq from q_norm) || '%' then 'body'
        when m.era   ilike '%' || (select qq from q_norm) || '%' then 'era'
        when (select qq from q_norm) = any(m.tags)               then 'tag'
        else                                                          'photo_tag'
      end as matched_via
    from public.memories m
    where not m.is_hidden
      and m.parent_id is null
      and (
        m.title   ilike '%' || (select qq from q_norm) || '%'
        or m.body ilike '%' || (select qq from q_norm) || '%'
        or m.era  ilike '%' || (select qq from q_norm) || '%'
        or (select qq from q_norm) = any(m.tags)
        or exists (
          select 1
          from public.memory_media mm
          join public.memory_image_pins p on p.media_id = mm.id
          where mm.memory_id = m.id
            and p.resolved
            and p.resolved_answer ilike '%' || (select qq from q_norm) || '%'
        )
      )
      and (
        m.visibility = 'public'
        or (m.visibility = 'community' and auth.uid() is not null)
        or m.author_id = auth.uid()
      )
  )
  select
    c.id, c.lat, c.lng, c.place_name, c.title,
    left(coalesce(c.body, ''), 220) as body_excerpt,
    c.era, c.tags, c.matched_via,
    null::text as hero_url,
    (select mm.storage_path from public.memory_media mm where mm.memory_id = c.id order by (mm.kind = 'photo') desc, mm.display_order limit 1) as hero_path,
    (select mm.kind         from public.memory_media mm where mm.memory_id = c.id order by (mm.kind = 'photo') desc, mm.display_order limit 1) as hero_kind,
    c.created_at
  from candidates c
  order by c.created_at desc
  limit result_limit;
$function$;

-- Recreated functions lose their grants. Restore exactly what was there.
grant execute on function public.fetch_memory_pins(numeric, numeric, numeric, numeric, integer) to anon, authenticated, service_role;
grant execute on function public.search_memories(text, integer)                                 to anon, authenticated, service_role;

commit;
