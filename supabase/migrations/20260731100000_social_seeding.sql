-- ────────────────────────────────────────────────────────────────────────────
-- Social seeding engine ("Peerie Press") — Phase 1.
--
-- Everything interesting on the platform becomes a queued, branded social post:
--   composer edge fn (recipes) → social_posts queue → admin review at
--   /admin/social → publisher edge fn → Facebook Page (Instagram in Phase 2).
--
-- social_recipes  — one row per recipe (wird o' da day, weekly roundup, …)
--                   with an enabled switch now and an autopilot switch reserved
--                   for Phase 2 (autopilot = publish without human approval).
-- social_posts    — the queue + permanent delivery log. Lifecycle:
--                   draft → approved/scheduled → posted | failed | skipped.
--
-- Idempotency: (kind, entity_id) is unique, so a recipe can re-run forever and
-- never queue the same word/event/week twice.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.social_recipes (
  key         text primary key,
  label       text not null,
  enabled     boolean not null default true,
  autopilot   boolean not null default false, -- Phase 2: skip human approval
  config      jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists public.social_posts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind = any (array[
                  'wird_of_day','whats_on_roundup','event_spotlight',
                  'offer_roundup','business_spotlight','ship_day',
                  'new_business','almanac_article','jobs_roundup','custom'])),
  -- What platform thing this post is about (dedupe + deep-linking back).
  entity_type   text,
  entity_id     text,
  -- Set when the post is a paid/tier slot for a specific business.
  business_id   uuid references public.local_businesses(id) on delete set null,
  caption       text not null,
  image_url     text,
  link_url      text,
  channels      text[] not null default array['facebook']
                check (channels <@ array['facebook','instagram']),
  status        text not null default 'draft'
                check (status = any (array['draft','approved','scheduled','posted','failed','skipped'])),
  scheduled_for timestamptz,
  posted_at     timestamptz,
  posted_ids    jsonb not null default '{}'::jsonb, -- {"facebook":"<id>","instagram":"<id>"}
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- A recipe never queues the same entity twice (word, event, ISO week, …).
create unique index if not exists social_posts_kind_entity_uniq
  on public.social_posts (kind, entity_id) where entity_id is not null;

-- Publisher pick: due posts, oldest schedule first.
create index if not exists social_posts_due_idx
  on public.social_posts (status, scheduled_for);

create index if not exists social_posts_business_idx
  on public.social_posts (business_id) where business_id is not null;

drop trigger if exists social_posts_updated_at on public.social_posts;
create trigger social_posts_updated_at
  before update on public.social_posts
  for each row execute function public.set_updated_at();

drop trigger if exists social_recipes_updated_at on public.social_recipes;
create trigger social_recipes_updated_at
  before update on public.social_recipes
  for each row execute function public.set_updated_at();

-- ── RLS: admin-only. The composer/publisher edge fns use the service role. ──
alter table public.social_posts enable row level security;
alter table public.social_recipes enable row level security;

drop policy if exists "admins manage social posts" on public.social_posts;
create policy "admins manage social posts" on public.social_posts
  for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "admins manage social recipes" on public.social_recipes;
create policy "admins manage social recipes" on public.social_recipes
  for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ── Seed the Phase 1 recipes ────────────────────────────────────────────────
insert into public.social_recipes (key, label, config) values
  ('wird_of_day',      'Wird o'' da Day',        '{"hour": 8}'),
  ('whats_on_roundup', 'Whit''s On dis week',    '{"weekday": 1, "hour": 9, "max_events": 8}'),
  ('event_spotlight',  'Event spotlight (premium)', '{"hour": 18, "max_per_run": 2}')
on conflict (key) do nothing;
