-- places-search: the rate-limit policies its enforceRateLimit() call depends on.
-- claim_rate_limits() DENIES any action it does not recognise, so these must
-- exist before the function that references them is deployed (the same
-- ai-cover-letter/calculate-fee ordering trap).
--
-- Sized for live typing: the widget debounces at 250-300ms, so a single address
-- search can legitimately fire 10-20 autocomplete calls plus one details call.
-- 180/hour comfortably covers several searches in one sitting; 800/day covers a
-- full day of normal use by one account, while still bounding what an abusive
-- signed-in account could spend on our key.
insert into public.rate_limit_policies (action, max_count, window_seconds, note) values
  ('places_search',     180, 3600,  'places-search: Google Places Autocomplete/Details per signed-in account, per hour'),
  ('places_search_day', 800, 86400, 'places-search: Google Places Autocomplete/Details per signed-in account, per day')
on conflict (action) do update
  set max_count = excluded.max_count, window_seconds = excluded.window_seconds, note = excluded.note;
