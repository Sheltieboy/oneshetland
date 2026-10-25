# Production reconciliation — 8 October 2026

This tree represents the backend that is live in production. Production (migration history, function bundles, catalog) was the authority;
git history was used for provenance.

> **Update, 2026-10-08:** the 29 hand-applied migrations have since been registered in production's migration history (see `MIGRATION-HISTORY.md`).
> The repository and production history now agree; `scripts/check-migration-history.mjs` exits 0.

## Sources

* Migrations: the `home-redesign` lineage at `8a39947` (every migration production has applied), with four historical files restored to the
  version production recorded (see `MIGRATION-HISTORY.md`) and two previously untracked live migrations committed.
* Edge Functions: all 100 deployed functions. Every deployed `index.ts` is byte-identical to the source here. `wallet-checkout` (v55) and
  `local-billing-portal` (v40) had been deployed from uncommitted working-tree edits; they are committed exactly as deployed.
* `_shared`: the latest canonical source. The deployed shared-file skew is recorded in the manifest, not hidden (`EDGE-FUNCTION-DEPLOYMENT.md`).

## Intentionally excluded

Home V2 / Local V2 and preview work; mobile UI and the build-147 mobile source; Android-only `945e447`; one-off data operations
(`supabase/data-fixes/`); `supabase/.temp`, `.DS_Store`, `deno.lock`; tests whose purpose is to inspect mobile or web source (they remain in
the lineage; several mix backend contracts with UI assertions and need splitting before they can be hermetic); any migration production has
not applied (there are none).

## Known live state that is recorded, not corrected

**`public.local_businesses_public` grants.** The view is `security_invoker`. Production's ACL is the default full set for `anon` and
`authenticated` (INSERT/SELECT/UPDATE/DELETE/REFERENCES/TRIGGER); `20260925120000` as recorded granted SELECT on named columns and as later
edited said `revoke all … grant select`; neither matches. Effective behaviour today: the view runs with the caller's rights, so the base
table decides — `anon` has column-level SELECT on 42 columns (the view exposes 44), INSERT/UPDATE policies require `owner_id = auth.uid()`
(false for anon) and there is no DELETE policy, so writes through the view are refused by row security. The mismatch is left for a separate
security decision; reconciliation does not change production semantics.

**Functions bundling older shared files.** See the manifest. In particular `wallet-checkout`, `local-wallet-pay`, `wallet-charge-approve` and
`create-hub-membership-intent` still bundle the pre-`a670f1a` `self-payment.ts`.

**`product_import_foundation`** is applied in production and kept here although its web feature is not exposed.

## What the repository now proves about itself

* `npm test` — 55 hermetic test files (no network, no production). `npm run test:isolated` — 46 suites on a throwaway PostgreSQL.
  `npm run test:replay` — every migration replayed from scratch and fingerprinted against production (5,040 objects; 3 cosmetic differences, explained).
* Edge Functions: all 100 deployed `index.ts` files are byte-identical to the source here; 42 functions bundle exactly what is committed, 58
  bundle older `_shared` files (recorded in the manifest and surfaced by `scripts/check-function-deploy.mjs`). `deno check`: 87 of 100 pass; the
  other 13 (`apple-wallet-pass`, `google-wallet-pass`, `local-billing-portal`, `local-boost-checkout`, `local-redeem-verify`, `local-subscription-*`,
  `refund-payment`, `refund-reconcile`, `refund-reconcile-sweep`, `stripe-webhook`) have type errors that exist identically in the pre-reconciliation
  lineage and do not affect the deployed bundles (the Deno bundler does not type-check). They are recorded, not fixed.

## Tests

* `test:fixtures` (70 files) reads and WRITES the live production project; it refuses to run unless `ALLOW_PRODUCTION_FIXTURES=1`. Run single
  named tests instead. They were inspected and not run during reconciliation.
* Quarantined — tests that exist on `origin/main`, fail against the reconciled backend because they also assert mobile/web source, and were already
  failing against `origin/main` itself or are frontend-coupled; kept in the tree, in no script: boost-offer-staleness, business-outcomes, cardless-first-purchase, hub-column-projection, hub-payout-notice, local-offer-presentation, mobile-hub-payout-entry, mobile-ticket-qr-fallback, privacy-cookie-disclosure, redemption-preview-and-balance, saved-card-invariants, shift-management-and-boost-visibility, unit-purchase-and-redemption, web-saved-card-checkout.
* Not imported (they inspect mobile or web source, or mix such assertions with backend ones; they stay in the `home-redesign` lineage and need splitting
  before they can live here): auth-captcha-full-coverage, book-discovery-tier-entitlement, book-service-first-discovery, business-claims-surfaces, business-dashboard-add-capability-chooser, business-dashboard-events-card, business-dashboard-focus-refresh, business-detail-ticket-routing, business-next-event, business-payout-status-parity, business-profile-tickets-intent, dashboard-payout-status-fields, event-create-per-order-max, event-manage-focus-refresh, event-manage-ticket-capacity, event-order-management, event-price-label, event-price-label-web, event-publish-gate-ux, event-ticket-saved-card, events-listing, events-management-index, gift-to-book-discovery, google-wallet-pass-function, home-local-screens, jobs-listing, launch-grant-display, launch-partner-admin-ui, launch-readiness-dashboard, local-page-layout, local-passes-discovery, loyalty-scanner-clarity, memory-audio-mime-repair, memory-create-journey, memory-detail-freeze-repair, memory-map-picker-refinement, memory-media-upload-repair, mobile-analytics-consent, mobile-onboarding-wizard, mobile-signin-never-hangs, mobile-turnstile-challenge-page, my-tickets-privacy, not-found-recovery, notification-centre, pass-redemption-stale-state, payout-activation-gate, payout-loading-feedback, payout-rate-limit-resilience, payout-setup-launcher, places-search, preview-work-jobs-shifts, purchase-attempt-clients, redeem-session-freshness, refund-reconciliation, saved-card-reconcile, sign-in-password-toggle, signup-cross-device-confirmation-and-consent, social-autopilot-and-pause, support-paths, ticket-celebration, ticket-lifecycle, ticket-ownership-display, ticket-type-save, transactions-ledger-economics-display, turnstile-signup-protection, wallet-charge-cancel, wallet-checkout-liquidity, wallet-event-reconcile-core, wallet-failed-transfer-display, wallet-liquidity, wallet-liquidity-funding, wallet-liquidity-ux, wallet-push-funding, wallet-sheet-failure, wallet-take-payment-discoverability, wallet-tier-fees-and-savings, web-google-wallet-button, web-home-local-ia, web-preview-v2, web-wallet-charge-approval.
* Frontend-only `describe` blocks were removed from `business-wallet-refunds` and `statement-refund-accounting` (their SQL tests are kept and pass).
* The loyalty/pass fixtures that sliced `nudge_reminded_at` out of `20260721020000_loyalty_reminders` now slice it from `20260803120000_fix_missing_nudge_reminded_at`,
  where production actually received it.

## Hand-applied deltas

Three live changes exist in no recorded migration; they are in `supabase/production/hand-applied-supplements/` (see `MIGRATION-HISTORY.md`).
