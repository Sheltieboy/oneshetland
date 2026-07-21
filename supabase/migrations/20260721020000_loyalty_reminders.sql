-- ============================================================================
-- Loyalty: proactive reminder gates.
--
-- The reminder-runner scheduled job sends "your reward is waiting" and "your
-- pass expires soon" pushes. These columns make each reminder idempotent —
-- a nulled gate means "not yet reminded for the current state", a timestamp
-- means "already sent", so overlapping/re-runs never double-send.
--
--   • local_loyalty_cards.reward_reminded_at — set when we push "reward ready".
--     Cleared when the reward is redeemed (stamps reset to 0) so the next
--     completed card re-arms.
--   • local_loyalty_cards.nudge_reminded_at — set when we push "one more stamp".
--     Cleared on every stamp collection so it re-evaluates as the card fills.
--   • book_unit_purchases.expiry_reminded_at — set when we push "pass expiring".
--     One push per pass; no reset needed (a used-up pass drops out of scope).
-- ============================================================================

alter table public.local_loyalty_cards
  add column if not exists reward_reminded_at timestamptz;

alter table public.local_loyalty_cards
  add column if not exists nudge_reminded_at timestamptz;

alter table public.book_unit_purchases
  add column if not exists expiry_reminded_at timestamptz;
