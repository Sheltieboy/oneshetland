-- Site-wide search: one cheap, forgiving, read-only RPC behind the new search box and /search page.
--
-- WHY: search was five separate per-section `ilike '%q%'` reads. They could not match "harrys" to "Harry's"
-- (punctuation), had no spelling tolerance, and a visitor had to guess the right section first.
--
-- DESIGN: public.search_site(q, limit) searches businesses, events, jobs, boats, Spik and hubs in ONE round trip.
--   * SECURITY INVOKER: the caller's own row security applies (anon sees only what the site already shows), and every
--     visibility predicate the existing site loaders use is repeated here, so a hidden / fixture / expired / private row can
--     never be suggested.
--   * Normalised matching: case, punctuation, apostrophes, spacing and accents are ignored ("Harry's" = "harrys",
--     "LK 889" = "lk889").
--   * Ranking: exact 100 > starts-with 85 > word-starts-with 70 > all words present 62 > contains 55 > weaker fields 25-30.
--   * Close matches (spelling variants) via pg_trgm, flagged close=true and only used when they clear a deliberate bar,
--     so unrelated rows are not suggested.
--   * Bounded: input trimmed to 60 chars, results capped (max 40), at most 6 per kind, STABLE. The tables are a few
--     thousand rows in total, so this is an in-memory scan of well under 5,000 rows; no index is needed at this size.
--   * Cheap by construction: spelling tolerance (the costly part) runs ONLY when nothing matched by name, and the weaker
--     fields (description, address) use a plain lower-case substring test, not the full normaliser.
--     The function reads nothing that is private and writes nothing. (Supabase also caps the anon role's statements.)

create extension if not exists fuzzystrmatch with schema extensions;

-- Pure text helpers deliberately carry NO `set search_path`: that would stop the planner inlining them, and they run once per row.
-- They use only built-in functions and fully qualified names, so there is nothing for a search_path to redirect.
create or replace function public.search_norm(t text) returns text
language sql immutable parallel safe
as $$
  select btrim(regexp_replace(
    translate(replace(replace(replace(replace(lower(coalesce(t, '')), '''', ''), '’', ''), '‘', ''), '`', ''),
              'àáâäãåèéêëìíîïòóôöõùúûüýÿçñ', 'aaaaaaeeeeiiiiooooouuuuyycn'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- The visible candidate rows, one per searchable thing. INVOKER rights: the caller's row security applies on top of the
-- explicit visibility rules below (the same ones the site's own loaders use).
create or replace function public.search_cands()
returns table (k text, r text, t text, s text, n text, x text)
language sql stable security invoker
as $$
  -- BUSINESSES: active and not a hidden fixture
  select 'business'::text, coalesce(b.slug, b.id::text), b.name, coalesce(b.category, ''), public.search_norm(b.name),
         lower(coalesce(b.description, '') || ' ' || coalesce(b.address, '') || ' ' || coalesce(b.category, '') || ' ' || coalesce(array_to_string(b.tags, ' '), ''))
    from public.local_businesses b
   where b.is_active = true and not public.is_discovery_hidden('business', b.id)
  union all
  -- EVENTS: not hidden, calendar-approved when hub-run, not yet over; a recurring event is ONE suggestion (the soonest date)
  (select distinct on (public.search_norm(e.title)) 'event', e.id::text, e.title, coalesce(e.venue, ''), public.search_norm(e.title), lower(coalesce(e.venue, '') || ' ' || coalesce(e.category, ''))
     from public.events e
    where e.is_hidden = false
      and (e.organiser_hub_id is null or e.calendar_approved = true)
      and (e.starts_at >= now() or coalesce(e.ends_at, e.starts_at) >= now())
    order by public.search_norm(e.title), e.starts_at)
  union all
  -- JOBS: open, not hidden, not expired
  select 'job', j.id::text, j.title, coalesce(j.location, ''), public.search_norm(j.title), lower(coalesce(j.location, '') || ' ' || coalesce(j.category, ''))
    from public.jobs j
   where j.status = 'open' and j.is_hidden = false and (j.expires_at is null or j.expires_at > now())
  union all
  -- BOATS: names, former names, LK / registration numbers. Read from the base tables (public read), NOT the vessel_search view: that
  -- view joins and aggregates four tables and costs ~220 ms per scan on production.
  select 'boat', v.id::text, v.canonical_name, coalesce(v.primary_lk_number, ''),
         public.search_norm(v.canonical_name || ' ' || coalesce(v.primary_lk_number, '')),
         public.search_norm(coalesce((select string_agg(n.name, ' ') from public.vessel_names n where n.vessel_id = v.id), '') || ' ' ||
                            coalesce((select string_agg(r.registration, ' ') from public.registrations r where r.vessel_id = v.id), ''))
    from public.vessels v
  union all
  -- SPIK: the word and alternative spellings; the meaning is a weaker field
  select 'spik', d.slug, d.word, coalesce(d.short_meaning, ''), public.search_norm(d.word || ' ' || coalesce(d.alternate_spelling, '')), lower(coalesce(d.short_meaning, ''))
    from public.spik_dictionary d
   where d.slug is not null
  union all
  -- HUBS: active and not a hidden fixture
  select 'hub', h.id::text, h.name, coalesce(h.area, ''), public.search_norm(h.name), lower(coalesce(h.type, '') || ' ' || coalesce(h.area, ''))
    from public.hubs h
   where h.is_active = true and not public.is_discovery_hidden('hub', h.id)
$$;

-- How well one candidate matches by NAME (0 = not at all), plus a weak 25 for the secondary fields.
create or replace function public.search_hit(n text, x text, q text, qc text) returns numeric
language sql immutable parallel safe
as $$
  select (case
    when n = q or replace(n, ' ', '') = qc then 100
    when n like q || '%' or replace(n, ' ', '') like qc || '%' then 85
    when n like '% ' || q || '%' then 70
    when (select bool_and(n like tok || '%' or n like '% ' || tok || '%') from unnest(string_to_array(q, ' ')) tok) then 62
    when n like '%' || q || '%' or replace(n, ' ', '') like '%' || qc || '%' then 55
    when length(q) >= 3 and x like '%' || q || '%' then 25
    else 0 end)::numeric
$$;

create or replace function public.search_site(p_q text, p_limit int default 8)
returns table (kind text, ref text, title text, subtitle text, score numeric, close boolean)
language plpgsql stable security invoker set search_path = public, extensions
as $fn$
declare
  q  text := public.search_norm(left(coalesce(p_q, ''), 60));
  qc text;
  lim int := greatest(1, least(coalesce(p_limit, 8), 40));
  strong boolean;
begin
  if length(q) < 2 then return; end if;
  qc := replace(q, ' ', '');

  -- Is there ANY match by name? EXISTS stops at the first one, so the common case is cheap. Spelling tolerance (the costly
  -- part) is only switched on when this is false.
  strong := exists (select 1 from public.search_cands() c where public.search_hit(c.n, c.x, q, qc) >= 55);

  return query
  with scored as (
    select c.k, c.r, c.t, c.s,
      public.search_hit(c.n, c.x, q, qc) as hit,
      -- Where a name appears matters less than whether it is a place/business a visitor is looking for:
      -- places and events first, the dictionary last (Spik has its own section).
      (case c.k when 'business' then 0 when 'hub' then 0 when 'event' then -3 when 'job' then -4 when 'boat' then -5 else -35 end)::numeric as bias,
      -- Spelling tolerance for NAMES only, a fallback used only when nothing matched by name: a single typed word is compared
      -- with each word of the name (same first letter, similar length, edit distance 1 for words up to 6 letters / 2 for
      -- longer ones); a multi-word query uses compact trigram similarity. 4+ characters only.
      case
        when strong or length(qc) < 4 then 0
        when position(' ' in q) = 0 then coalesce((
          select greatest(0, 1 - lev::numeric / (case when length(qc) <= 6 then 2 else 3 end))
            from (select min(levenshtein(w, qc)) lev from unnest(string_to_array(c.n, ' ')) w
                   where length(w) >= 4 and left(w, 1) = left(qc, 1) and abs(length(w) - length(qc)) <= 2) z
           where lev <= (case when length(qc) <= 6 then 1 else 2 end)), 0)
        when left(replace(c.n, ' ', ''), 1) = left(qc, 1) then (case when similarity(replace(c.n, ' ', ''), qc) >= 0.55 then similarity(replace(c.n, ' ', ''), qc) else 0 end)
        else 0
      end as sim
    from public.search_cands() c
  ),
  final as (
    select g.k, g.r, g.t, g.s,
           (case when g.hit > 0 then greatest(g.hit + g.bias, 5) else 20 + 30 * g.sim end)::numeric as sc,
           (g.hit = 0) as cl
      from scored g
     where g.hit > 0 or g.sim > 0
  ),
  ranked as (
    select f.*, row_number() over (partition by f.k order by f.sc desc, length(f.t), f.t) rn from final f
  )
  select r2.k, r2.r, r2.t, r2.s, round(r2.sc, 1), r2.cl
    from ranked r2
   where r2.rn <= 6
   order by r2.cl, r2.sc desc, r2.k, r2.t
   limit lim;
end
$fn$;

revoke all on function public.search_cands() from public;
revoke all on function public.search_hit(text, text, text, text) from public;
revoke all on function public.search_site(text, int) from public;
grant execute on function public.search_site(text, int) to anon, authenticated;
revoke all on function public.search_norm(text) from public;
grant execute on function public.search_norm(text) to anon, authenticated;
-- search_cands / search_hit are internal helpers: they are called from search_site under the caller's own rights, so the caller needs
-- EXECUTE on them too (they expose nothing beyond what search_site itself returns, and row security still applies).
grant execute on function public.search_cands() to anon, authenticated;
grant execute on function public.search_hit(text, text, text, text) to anon, authenticated;

comment on function public.search_site(text, int) is 'Site-wide forgiving search (businesses, events, jobs, boats, Spik, hubs). Read-only, invoker rights, bounded.';
