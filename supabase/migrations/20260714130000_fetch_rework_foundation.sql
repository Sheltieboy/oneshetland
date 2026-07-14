-- Fetch rework — foundation (additive, idempotent).
--
-- Adds the data the run-first rework needs, without changing any existing
-- behaviour on its own:
--   • delivery_requests gains a "when" (needed_by + scheduling_mode) and an
--     expiry (expires_at) so a request no longer sits pending forever, and a
--     new terminal status 'expired' (distinct from a customer 'cancelled').
--   • runs gains a capacity so the long-defined-but-unreachable 'full' status
--     can actually be set once a run is carrying its limit.
--
-- The route lives on columns that ALREADY exist on both tables
-- (runs.origin_region_id / destination_region_id / destination_area,
-- delivery_requests.destination_region_id / destination_area) — the rework
-- switches the code to use them instead of a free-text notes blob, so no new
-- route columns are needed here.

-- ── delivery_requests: scheduling + expiry ──────────────────────────────────
alter table public.delivery_requests
  add column if not exists needed_by       timestamptz,                 -- null = flexible / no fixed time
  add column if not exists scheduling_mode text not null default 'asap', -- asap | by | flexible
  add column if not exists expires_at      timestamptz;                  -- auto-expire if still unmatched by this

alter table public.delivery_requests
  drop constraint if exists delivery_requests_scheduling_mode_check;
alter table public.delivery_requests
  add constraint delivery_requests_scheduling_mode_check
  check (scheduling_mode = any (array['asap'::text, 'by'::text, 'flexible'::text]));

-- widen status to include 'expired'
alter table public.delivery_requests
  drop constraint if exists delivery_requests_status_check;
alter table public.delivery_requests
  add constraint delivery_requests_status_check
  check (status = any (array[
    'pending'::text, 'matched'::text, 'collected'::text,
    'delivered'::text, 'cancelled'::text, 'expired'::text
  ]));

-- Helps the expiry sweeper and the "still waiting" queries.
create index if not exists idx_delivery_requests_pending_expiry
  on public.delivery_requests (expires_at)
  where status = 'pending';

-- ── runs: capacity (makes 'full' reachable) ─────────────────────────────────
alter table public.runs
  add column if not exists capacity int;   -- null = driver hasn't set a limit
