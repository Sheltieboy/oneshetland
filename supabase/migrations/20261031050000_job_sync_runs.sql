-- A durable record of every council-jobs sync run.
--
-- The sync (sync-council-jobs, every three hours) broke silently when myjobscotland upgraded its site in
-- September 2026: for four days every run answered "parsed 0 — left existing rows untouched". The fail-safe worked
-- (no good data was lost) but the only trace was the HTTP response, which pg_net keeps for about six hours, so the
-- feed went stale unnoticed. Each run now writes one row here, so "when did it last succeed, and what went wrong"
-- is a query, not an archaeology exercise. Rows older than 30 days are trimmed by the function itself.
--
-- Written by the function with the service role. Admins can read it; nobody else can.

create table if not exists public.job_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  ran_at        timestamptz not null default now(),
  source        text not null,
  ok            boolean not null,
  reason        text,
  parsed        integer not null default 0,
  removed       integer not null default 0,
  prune_skipped boolean not null default false,
  duration_ms   integer
);

create index if not exists job_sync_runs_recent on public.job_sync_runs (source, ran_at desc);

alter table public.job_sync_runs enable row level security;

drop policy if exists "Admins read job sync runs" on public.job_sync_runs;
create policy "Admins read job sync runs" on public.job_sync_runs
  for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

revoke all on public.job_sync_runs from anon, authenticated;
grant select on public.job_sync_runs to authenticated;   -- row security limits this to admins
