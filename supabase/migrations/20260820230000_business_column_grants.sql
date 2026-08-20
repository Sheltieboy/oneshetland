-- ============================================================================
-- The business directory's column whitelist takes effect.
--
-- Part two of the H7 remediation. The functions and indexes landed in
-- 20260820220000 while the old clients were still running; this is the part
-- that actually takes something away, and it is applied only after the clients
-- that name their columns are deployed and verified live.
--
-- Before this: local_businesses granted arwdDxtm to anon and authenticated,
-- and RLS filtered ROWS only. Verified against production — an anonymous
-- caller could list owner_id, stripe_account_id, stripe_customer_id,
-- stripe_subscription_id and nfc_token for any active business.
--
-- After this: a client role can read only the columns named below. `select *`
-- becomes a permission error, which is the property that matters — a column
-- added to this table next month is private until somebody deliberately adds
-- it to this list.
--
-- RLS is untouched and still decides which ROWS. Column privileges decide which
-- COLUMNS. Neither is sufficient alone, and `authenticated` is every signed-in
-- user, so neither can express ownership — that is what
-- business_private_fields() is for.
-- ============================================================================

-- ── The public directory surface ────────────────────────────────────────────
--
-- Everything a directory listing, a business page, a public event page or the
-- trades finder legitimately shows. Contact details are here deliberately:
-- phone, email and address are what a business PUBLISHES in its listing, and
-- treating published contact details as a leak would break the product for no
-- security gain.
--
-- payout_enabled is here because a public event page reads it to decide whether
-- tickets can be bought. It is a boolean about readiness, not a credential —
-- the safe derived state that replaces exposing the account id behind it.
--
-- subscription_tier and subscription_until are here because public ranking uses
-- them: a Pro listing visibly outranks a free one. That a business pays for a
-- tier is already observable from where it appears.
do $$
declare
  -- Keep this list alphabetical and one name per line. It is read by people
  -- deciding whether a new column is safe, and that decision should be hard to
  -- make carelessly.
  safe_cols constant text[] := array[
    'accepts_bookings', 'accepts_wallet', 'address', 'brand_color', 'can_publish_urgent',
    'cashback_percent', 'category', 'claimed_at', 'cover_url', 'created_at',
    'description', 'email', 'id', 'is_active', 'is_claimed', 'is_verified',
    'lat', 'lng', 'logo_url', 'name', 'opening_hours', 'opening_hours_until',
    'payout_enabled', 'phone', 'planner_booking', 'planner_context_source',
    'planner_dwell_minutes', 'planner_good_for', 'planner_note', 'planner_setting',
    'planner_visitor_ready', 'slug', 'subscription_tier', 'subscription_until',
    'tags', 'trade_availability', 'trade_availability_set_at', 'trade_categories',
    'trade_credentials', 'trade_min_job_pence', 'verified_at', 'website'
  ];
  col text;
begin
  -- Table-wide SELECT goes first. After this, no column is readable by a client
  -- unless it is named below — the whitelist default.
  execute 'revoke select on public.local_businesses from anon';
  execute 'revoke select on public.local_businesses from authenticated';

  foreach col in array safe_cols loop
    execute format('grant select (%I) on public.local_businesses to anon', col);
    execute format('grant select (%I) on public.local_businesses to authenticated', col);
  end loop;

  -- owner_id is granted to authenticated ONLY, never to anon.
  --
  -- Several signed-in flows check "is this mine?" by reading owner_id, and
  -- those are legitimate. A signed-in user learning which account owns a
  -- business is a much smaller thing than the whole internet enumerating the
  -- business → person mapping, which is what anon could do.
  execute 'grant select (owner_id) on public.local_businesses to authenticated';
end $$;

-- Writes are unchanged: the existing RLS policies still decide who may INSERT
-- and UPDATE, and those policies are already owner-scoped.


