-- Hide blocked users' memories from the map/feed (UGC block must be effective
-- everywhere — Apple 1.2). The fetch_memory_pins RPC gains a server-side block
-- filter via is_blocked_pair() and now also returns author_id. Return-type
-- change requires DROP + CREATE.

drop function if exists public.fetch_memory_pins(numeric, numeric, numeric, numeric, integer);

create function public.fetch_memory_pins(
  min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric, result_limit integer default 500
) returns table(
  id uuid, lat numeric, lng numeric, place_name text, title text, era text, tags text[],
  media_count integer, comment_count integer, reaction_count integer, child_count integer,
  hero_url text, hero_kind text, created_at timestamp with time zone, author_id uuid
)
language sql stable security definer as $$
  select
    m.id, m.lat, m.lng, m.place_name, m.title, m.era, m.tags,
    m.media_count, m.comment_count, m.reaction_count, m.child_count,
    (select mm.url  from public.memory_media mm where mm.memory_id = m.id order by (mm.kind = 'photo') desc, mm.display_order limit 1) as hero_url,
    (select mm.kind from public.memory_media mm where mm.memory_id = m.id order by (mm.kind = 'photo') desc, mm.display_order limit 1) as hero_kind,
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
$$;

grant all on function public.fetch_memory_pins(numeric, numeric, numeric, numeric, integer) to anon, authenticated, service_role;
