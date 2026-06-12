-- 061_business_tags.sql
-- Trade/service tags for the business directory search. Owners pick from a
-- curated list (or add their own); directory search matches against these so
-- "plumber", "joiner", "builder" etc. reliably find the right businesses even
-- though the coarse `category` only has 6 buckets.

alter table public.local_businesses
  add column if not exists tags text[] not null default '{}';

-- GIN index for fast array containment/overlap queries as the directory grows.
create index if not exists idx_local_businesses_tags
  on public.local_businesses using gin (tags);

comment on column public.local_businesses.tags is
  'Trade/service tags (e.g. Plumbing, Joinery) used by directory search.';
