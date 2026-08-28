-- A ceiling on the Fetch authorisation-continuation endpoint.
--
-- The rate-limit contract test caught it the moment the function existed:
-- "these can cost money or reach people, with no ceiling and no recorded
-- reason: fetch-authorise (STRIPE)". It is right — every call retrieves a
-- PaymentIntent from Stripe, and an account could sit on it.
--
-- Deliberately generous. The customer's panel checks on open and again after
-- they finish with their bank, and somebody watching a delivery may reopen it
-- several times; being refused while trying to authorise a payment would be a
-- worse failure than the one being prevented.
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('fetch_authorise',     3600,  120, 'each call retrieves a PaymentIntent from Stripe'),
  ('fetch_authorise_day', 86400, 600, 'daily ceiling so the hourly limit cannot be farmed round the clock')
on conflict (action) do update
  set window_seconds = excluded.window_seconds,
      max_count      = excluded.max_count,
      note           = excluded.note;
