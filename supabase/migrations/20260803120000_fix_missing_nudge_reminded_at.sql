-- local_loyalty_cards.nudge_reminded_at is missing on the remote database even
-- though 20260721020000_loyalty_reminders.sql is recorded as applied. Its two
-- sibling columns (reward_reminded_at, expiry_reminded_at) from the same file
-- are present, so that migration landed only partly — a re-run won't help
-- because the history table already lists it as done.
--
-- The damage was silent and total: every stamp and redemption path writes this
-- column (local-nfc-stamp, local-stamp-collect, loyalty-till,
-- local-redeem-verify), and none of them checked the update result. Postgres
-- rejected each write with 42703, the functions returned "Stamp collected!"
-- anyway, and cards stayed on zero while transaction rows piled up.
--
-- Idempotent, so it is safe wherever the column already exists.

alter table public.local_loyalty_cards
  add column if not exists nudge_reminded_at timestamptz;

-- Same belt-and-braces for the siblings, in case another environment lost a
-- different statement from that migration.
alter table public.local_loyalty_cards
  add column if not exists reward_reminded_at timestamptz;

alter table public.book_unit_purchases
  add column if not exists expiry_reminded_at timestamptz;
