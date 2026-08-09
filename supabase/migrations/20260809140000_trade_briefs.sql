-- "Get it done" — briefs for work, and the trades who can take it on.
--
-- THE PROBLEM, as heard repeatedly around Shetland: you cannot get a
-- tradesperson. The same handful are booked two years out, small jobs aren't
-- worth anyone's trip, and if you do find someone you often can't afford them.
-- A few names get all the work, which compounds — they're the only ones people
-- know to ask.
--
-- THE TRAP: a system that broadcasts every brief to every matching trade makes
-- that worse. The same five joiners would ignore forty requests a month
-- instead of four, and the homeowner's experience goes from "couldn't find
-- anyone" to "asked and was ignored" — worse, because it felt like a promise.
--
-- So the scarce fact here is not WHO DOES joinery (everyone does) but WHO HAS
-- ROOM. That's `trade_availability`, and it is the centre of the design.
--
-- It is a LEADS product, deliberately. No messaging, no threads, no escrow.
-- A trade says yes, gets a phone number, and rings. Anything else would be a
-- channel nobody would use and a liability we don't want.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. What a business can do, and whether it has room
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.local_businesses
  -- Fixed keys from constants/trades.ts, not free text: a brief has to be
  -- matched against these by code, and "all aspects of building work" cannot.
  add column if not exists trade_categories text[],

  -- The whole product in one column.
  --   now        — taking work on
  --   weeks      — a few weeks out
  --   months     — a few months out
  --   booked_up  — not taking anything on
  --   emergency  — emergencies only
  --   null       — hasn't said
  add column if not exists trade_availability text
    check (trade_availability is null or trade_availability in
      ('now', 'weeks', 'months', 'booked_up', 'emergency')),

  -- Availability set in March and never touched is a lie by June. Anything
  -- older than TRADE_AVAILABILITY_TTL_DAYS is treated as "hasn't said" and
  -- stops matching. Better to show nothing than something wrong — same rule as
  -- opening_hours_until.
  add column if not exists trade_availability_set_at timestamptz,

  -- Smallest job worth their trip, in pounds. Optional, and the single most
  -- useful thing a trade can say: it stops both sides wasting a call on a job
  -- that was never going to be worth doing.
  add column if not exists trade_min_job_pence integer
    check (trade_min_job_pence is null or trade_min_job_pence >= 0),

  -- Self-declared, and labelled as such everywhere it appears. We do not vet.
  add column if not exists trade_credentials text[];

comment on column public.local_businesses.trade_categories is
  'Fixed trade keys (joiner, plumber, electrician…) from constants/trades.ts. Matched by code, so never free text.';
comment on column public.local_businesses.trade_availability is
  'now | weeks | months | booked_up | emergency. The scarce fact — capability is not, everyone does joinery.';
comment on column public.local_businesses.trade_availability_set_at is
  'When availability was last confirmed. Stale entries stop matching rather than mislead.';
comment on column public.local_businesses.trade_min_job_pence is
  'Smallest job worth the trip. Stops both sides wasting a call.';
comment on column public.local_businesses.trade_credentials is
  'SELF-DECLARED only (insured, gas_safe, niceic…). We do not verify these and the UI must say so.';

create index if not exists local_businesses_trade_idx
  on public.local_businesses using gin (trade_categories)
  where is_active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The brief
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.trade_briefs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Signed-in only, like every other submission surface.
  author_id     uuid not null references public.profiles(id) on delete cascade,

  title         text not null check (length(trim(title)) between 3 and 120),
  description   text not null check (length(trim(description)) between 10 and 4000),

  -- Fixed keys. A brief can need more than one trade (a new bathroom wants a
  -- plumber, a joiner and a sparky), and saying so is how it reaches all three.
  trades        text[] not null default '{}',

  -- rough size, for triage in ten seconds
  scale         text not null default 'unsure'
    check (scale in ('small', 'day', 'multi_day', 'project', 'unsure')),

  urgency       text not null default 'flexible'
    check (urgency in ('emergency', 'weeks', 'months', 'flexible')),

  -- Where the work is. Free text (a house has no listing), plus coordinates
  -- when we can get them, so travel and bundling can be worked out.
  location_text text not null check (length(trim(location_text)) between 2 and 160),
  lat           double precision,
  lng           double precision,

  -- Contact is NOT included in the brief a trade browses. It is released only
  -- to a trade that has said yes — see trade_brief_matches. Broadcasting a
  -- phone number to twenty businesses is not a thing to do to somebody.
  contact_name  text,
  contact_phone text,
  contact_email text,

  photos        text[],

  status        text not null default 'open'
    check (status in ('open', 'sorted', 'withdrawn', 'expired')),
  -- Why it closed — 'sorted' via OneShetland is the number that proves this
  -- works; 'sorted' elsewhere is the number that says it doesn't.
  outcome       text
    check (outcome is null or outcome in ('via_oneshetland', 'elsewhere', 'gave_up', 'no_longer_needed')),

  -- An open brief nobody has answered in six weeks is not open, it's abandoned,
  -- and leaving it in the waiting-list count would flatter the numbers.
  expires_at    timestamptz not null default (now() + interval '42 days')
);

comment on table public.trade_briefs is
  'A piece of work somebody needs doing. Leads only — no messaging, no payments.';
comment on column public.trade_briefs.contact_phone is
  'Released ONLY to a trade that has accepted the brief. Never in a browse list.';
comment on column public.trade_briefs.outcome is
  'How it ended. via_oneshetland vs elsewhere is the honest measure of whether this works.';

create index if not exists trade_briefs_open_idx
  on public.trade_briefs (created_at desc)
  where status = 'open';
create index if not exists trade_briefs_trades_idx
  on public.trade_briefs using gin (trades);
create index if not exists trade_briefs_author_idx
  on public.trade_briefs (author_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Who it went to, and what they said
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.trade_brief_matches (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  brief_id    uuid not null references public.trade_briefs(id) on delete cascade,
  business_id uuid not null references public.local_businesses(id) on delete cascade,

  --   sent       — delivered to them
  --   viewed     — opened
  --   interested — yes: THIS is what releases the contact details
  --   declined   — a fast no, which is a service to the homeowner
  --   expired    — never answered
  status      text not null default 'sent'
    check (status in ('sent', 'viewed', 'interested', 'declined', 'expired')),

  -- Why not. Feeds the waiting-list story: "booked up" eleven times over is the
  -- evidence that Shetland is short of joiners, not that the app is broken.
  decline_reason text
    check (decline_reason is null or decline_reason in
      ('booked_up', 'too_small', 'too_far', 'wrong_trade', 'other')),

  responded_at timestamptz,

  -- One delivery per business per brief.
  unique (brief_id, business_id)
);

comment on table public.trade_brief_matches is
  'Delivery + response. `interested` is what releases the homeowner''s contact details.';
comment on column public.trade_brief_matches.decline_reason is
  'Aggregated into the unmet-demand figures — the recruitment pitch to trades who are not listed yet.';

create index if not exists trade_brief_matches_business_idx
  on public.trade_brief_matches (business_id, created_at desc);
create index if not exists trade_brief_matches_brief_idx
  on public.trade_brief_matches (brief_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.trade_briefs        enable row level security;
alter table public.trade_brief_matches enable row level security;

-- The author owns their brief.
drop policy if exists "author manages own brief" on public.trade_briefs;
create policy "author manages own brief" on public.trade_briefs
  for all using (author_id = auth.uid()) with check (author_id = auth.uid());

-- A business owner reads briefs sent to them. Contact columns are stripped by
-- the read path (lib/trades-data), not by RLS — Postgres RLS is row-level, and
-- column-level control here would mean a second view to maintain. The rule is
-- enforced in one place: nothing selects contact_* unless the match says
-- interested.
drop policy if exists "trade reads briefs sent to it" on public.trade_briefs;
create policy "trade reads briefs sent to it" on public.trade_briefs
  for select using (exists (
    select 1 from public.trade_brief_matches m
    join public.local_businesses b on b.id = m.business_id
    where m.brief_id = trade_briefs.id and b.owner_id = auth.uid()));

drop policy if exists "author reads own matches" on public.trade_brief_matches;
create policy "author reads own matches" on public.trade_brief_matches
  for select using (exists (
    select 1 from public.trade_briefs br
    where br.id = brief_id and br.author_id = auth.uid()));

drop policy if exists "trade reads own matches" on public.trade_brief_matches;
create policy "trade reads own matches" on public.trade_brief_matches
  for select using (exists (
    select 1 from public.local_businesses b
    where b.id = business_id and b.owner_id = auth.uid()));

-- A trade answers its own match, and nothing else about it.
drop policy if exists "trade responds to own match" on public.trade_brief_matches;
create policy "trade responds to own match" on public.trade_brief_matches
  for update using (exists (
    select 1 from public.local_businesses b
    where b.id = business_id and b.owner_id = auth.uid()));

drop policy if exists "admins manage briefs" on public.trade_briefs;
create policy "admins manage briefs" on public.trade_briefs
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "admins manage brief matches" on public.trade_brief_matches;
create policy "admins manage brief matches" on public.trade_brief_matches
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The waiting list — the number that recruits the supply side
-- ─────────────────────────────────────────────────────────────────────────────
--
-- "11 people are waiting for a plumber, typically 3 weeks unanswered" is the
-- most valuable thing this produces: the pitch to trades who aren't listed,
-- the case for apprenticeships, and a publishable story. It has to be readable
-- WITHOUT a login and without exposing a single brief, so it's an aggregate
-- function rather than a view over the table.

create or replace function public.trade_demand_summary()
returns table (
  trade            text,
  waiting          bigint,
  unanswered       bigint,
  avg_days_waiting numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t                                                    as trade,
    count(*)                                             as waiting,
    count(*) filter (where not exists (
      select 1 from public.trade_brief_matches m
      where m.brief_id = b.id and m.status = 'interested'
    ))                                                   as unanswered,
    round(avg(extract(epoch from (now() - b.created_at)) / 86400)::numeric, 1)
                                                         as avg_days_waiting
  from public.trade_briefs b
  cross join lateral unnest(b.trades) as t
  where b.status = 'open' and b.expires_at > now()
  group by t
  order by count(*) desc;
$$;

comment on function public.trade_demand_summary is
  'Unmet demand per trade. Aggregate only — no brief is exposed. Readable signed out; it is the recruitment pitch.';

grant execute on function public.trade_demand_summary() to anon, authenticated;
