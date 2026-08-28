-- ═══════════════════════════════════════════════════════════════════════════
-- A ceiling on the Fetch quote endpoint
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Split out of 20260905120000 rather than appended to it: that migration had
-- already been applied, so anything added to the file would have sat there
-- unrun and untrue.
--
-- The rate-limit contract test caught this the moment fetch-quote existed:
-- "these can cost money or reach people, with no ceiling and no recorded
-- reason: fetch-quote (PROVIDER)". It is right — the function geocodes two
-- addresses per call and Google bills per request.

-- ── 6. The quote calls a paid provider, so it gets a ceiling ───────────────
--
-- fetch-quote geocodes two addresses per call, and Google bills per request.
-- Without a limit any signed-in account could sit on the endpoint and spend
-- the platform's money. Two windows, the same shape as the transcribe pair:
-- an hourly limit for ordinary use, and a daily one so the hourly cannot be
-- farmed round the clock.
--
-- Generous enough for real use — a customer typing an address re-quotes as
-- they refine it — and nowhere near enough to be worth abusing.
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('fetch_quote',     3600,  60, 'Google Geocoding is billed per request; two lookups per quote'),
  ('fetch_quote_day', 86400, 300, 'daily ceiling so the hourly limit cannot be farmed round the clock')
on conflict (action) do update
  set window_seconds = excluded.window_seconds,
      max_count      = excluded.max_count,
      note           = excluded.note;
