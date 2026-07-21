-- ============================================================================
-- Loyalty: reward ladders (multi-tier stamp cards).
--
-- A business can offer several rewards on one card at rising stamp counts, e.g.
-- 5 stamps = 10% off, 10 = a free item. Stamps ACCUMULATE up the ladder: the
-- customer claims each tier as they pass it, and the card only resets after the
-- top tier is claimed.
--
--   • local_loyalty_programs.reward_tiers — jsonb array [{stamps:int, reward:text}]
--     sorted ascending. NULL / empty = legacy single-reward mode (the existing
--     stamps_required + stamp_reward still drive everything). Fully backward-
--     compatible: nothing reads reward_tiers unless it's populated.
--   • local_loyalty_cards.tiers_redeemed_upto — the stamp threshold of the
--     highest tier the customer has already claimed in the current cycle. A tier
--     T is claimable when stamps_collected >= T.stamps AND T.stamps > this value.
--     Reset to 0 (with stamps) when the top tier is claimed.
-- ============================================================================

alter table public.local_loyalty_programs
  add column if not exists reward_tiers jsonb;

alter table public.local_loyalty_cards
  add column if not exists tiers_redeemed_upto integer not null default 0;
