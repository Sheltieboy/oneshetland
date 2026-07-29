-- ============================================================================
-- The Shetland Almanac — a data-fed content engine.
--
-- Evergreen, Shetland-specific articles (drafted by Peerie Bot from OneShetland's
-- own data, reviewed and scheduled by an admin). Drives SEO with unique content
-- and cross-links into the directory / dialect / events pages.
--
-- Scheduling needs no cron: a "scheduled" row simply becomes publicly visible
-- once publish_at passes, because the public SELECT policy checks publish_at<=now().
-- ============================================================================

create table if not exists public.content_articles (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  title           text not null,
  excerpt         text,
  body            text not null default '',          -- markdown
  hero_url        text,
  pillar          text not null default 'island'
                    check (pillar in ('dialect','events','cruise','boats','local','island','jobs')),
  status          text not null default 'draft'
                    check (status in ('draft','scheduled','published','archived')),
  publish_at      timestamptz,
  seo_title       text,
  seo_description text,
  linked_entities jsonb not null default '[]'::jsonb, -- [{type,id,label}] for cross-linking
  source          jsonb,                              -- the data the piece was built from (for regen)
  author          text not null default 'OneShetland',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists content_articles_live_idx   on public.content_articles (status, publish_at);
create index if not exists content_articles_pillar_idx on public.content_articles (pillar);

alter table public.content_articles enable row level security;

-- Public can read only articles that are live (published/scheduled AND due).
drop policy if exists "public reads live articles" on public.content_articles;
create policy "public reads live articles" on public.content_articles
  for select using (
    status in ('published','scheduled')
    and publish_at is not null
    and publish_at <= now()
  );

-- Admins manage everything.
drop policy if exists "admins manage articles" on public.content_articles;
create policy "admins manage articles" on public.content_articles
  for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- keep updated_at fresh
create or replace function public.tg_content_articles_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists content_articles_touch on public.content_articles;
create trigger content_articles_touch before update on public.content_articles
  for each row execute function public.tg_content_articles_touch();
