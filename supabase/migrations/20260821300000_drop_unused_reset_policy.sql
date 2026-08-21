-- Step 15 follow-up — remove a policy that nothing claims.
--
-- 20260821280000 seeded `password_reset_email` (4/hour per hashed address)
-- intending to throttle reset mail per recipient. On reading the function it
-- turned out request-password-reset ALREADY does exactly that, and does it
-- better: it counts rows in email_log, so it measures mail that actually went
-- out rather than attempts, and it returns ok() when over the limit so the
-- endpoint still reveals nothing about whether an address is registered.
--
-- Only the endpoint-wide ceiling was genuinely missing, and that is
-- `password_reset_global`, which IS claimed.
--
-- The unused row is deleted rather than left in place: rate_limit_policies is
-- the answer to "what is limited here", and a row nothing claims makes that
-- answer wrong in the direction of claiming more protection than exists.

delete from public.rate_limit_policies where action = 'password_reset_email';
