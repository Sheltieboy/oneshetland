-- ============================================================================
-- Part two: the hub column whitelist takes effect.
--
-- Before this: public.hubs granted SELECT to anon and authenticated at TABLE
-- level, so RLS chose the rows and nothing chose the columns. An anonymous
-- caller could select stripe_account_id for any active hub.
--
-- After this: a client role can read only the columns named below. `select *`
-- becomes a permission error, which is the property that matters — a column
-- added to this table next month is private until somebody deliberately adds it
-- to this list.
--
-- A column-level REVOKE alone would have done nothing. In PostgreSQL a
-- table-level SELECT privilege covers every column, present and future; the
-- table grant has to go first, and the safe columns granted back individually.
-- That is why this migration looks heavier than "revoke one column".
--
-- ── APPLY ORDER MATTERS ─────────────────────────────────────────────────────
--
-- Any client still issuing `select *` against hubs stops working the moment
-- this is applied. At the time of writing the mobile app did exactly that in
-- four places (lib/hubs-api.ts), and an installed build cannot be corrected
-- without shipping an update. Those call sites now name their columns, but the
-- BUILD ON THE DEVICE is what matters, not the source.
--
-- So: apply this only once the clients that name their columns are live and
-- verified — the same sequencing 20260820230000 used for local_businesses.
-- Part one (20260928120000) is additive and can go ahead immediately.
--
-- RLS is untouched and still decides which ROWS.
-- ============================================================================

begin;

do $$
declare
  -- Alphabetical, one per line. It is read by people deciding whether a new
  -- column is safe to publish, and that decision should be hard to make
  -- carelessly.
  --
  -- payout_enabled is here deliberately, on the same reasoning local_businesses
  -- uses: it is a boolean about readiness, not a credential, and a public hub
  -- page needs it to decide whether paid membership can be offered at all. The
  -- account id behind it is what must never be published.
  safe_cols constant text[] := array[
    'area', 'brand_color', 'charity_number', 'contact_email', 'contact_phone',
    'cover_url', 'created_at', 'description', 'directory_enabled', 'id',
    'is_active', 'is_charity', 'is_verified', 'join_mode', 'logo_url',
    'memberships_enabled', 'name', 'payout_enabled', 'slug', 'type', 'website'
  ];
  col text;
begin
  -- Table-wide SELECT goes first. After this, no column is readable by a client
  -- role unless it is named below — the whitelist default.
  execute 'revoke select on public.hubs from anon';
  execute 'revoke select on public.hubs from authenticated';

  foreach col in array safe_cols loop
    execute format('grant select (%I) on public.hubs to anon', col);
    execute format('grant select (%I) on public.hubs to authenticated', col);
  end loop;

  -- owner_id to authenticated ONLY, never anon. Signed-in screens legitimately
  -- ask "is this mine?" (the mobile members screen does exactly that), which is
  -- a much smaller thing than letting the whole internet enumerate the
  -- hub → person mapping.
  execute 'grant select (owner_id) on public.hubs to authenticated';

  -- stripe_account_id is granted to NOBODY. service_role bypasses column
  -- privileges, so hub-onboard, the stripe-webhook account.updated handler,
  -- create-hub-membership-intent and wallet-checkout are unaffected. Admin
  -- screens ask hub_payout_ready() instead.
end $$;

-- Writes are unchanged: the existing RLS policies still decide who may INSERT
-- and UPDATE, and those are already owner-scoped.

commit;
