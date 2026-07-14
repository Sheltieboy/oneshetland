-- Fetch: pre-expiry reminder flag.
--
-- Before a pending request lapses to 'expired', reminder-runner nudges the
-- customer once ("still need this? keep looking or cancel"). This column gates
-- that nudge so it's sent at most once per request (cleared when the customer
-- extends, so a later window can nudge again). Additive + idempotent.

alter table public.delivery_requests
  add column if not exists reminder_sent_at timestamptz;
