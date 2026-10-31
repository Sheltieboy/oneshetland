# Incident 31 Oct 2026 — accidental production-linked test run

STATUS: investigated LOCALLY ONLY (process list, repository history, the session's recorded commands, local npm logs, static reading of test source). No production connection was made, no test was run, no SQL executed. **Nothing here proves production was unchanged.**

## 1. What happened
A command meant to run one isolated suite was started with a filter that matched nothing in `scripts/isolated-pg.mjs`. With an empty list, the runner executed `node --test --test-concurrency=1` with no file arguments, so Node **discovered and ran every `*.test.ts` file in the checkout**. About 100 of them run `npx supabase db query --linked`, and the checkout was linked to the production project. The run was invisible because its output was piped through `| head -60`, which stopped printing after 60 lines; the processes kept running.

I first reported that only anonymous reads had been made. That was wrong and was based on seeing only those 60 lines.

## 2. Project affected
`nkrtmakxygkvxuxriiil`, Supabase project name **oneshetland-delivers**, organisation `xcfcwwwrdmvtusqryohv`.
Evidence: `supabase/.temp/project-ref` and `linked-project.json` in the app worktree at commit `69cb020^` (tracked since the repository's initial commit, 20 May 2026); the primary checkout `oneshetland-delivers` is linked to the same ref; so are **all 23 sibling worktrees**. The constant `PRODUCTION_PROJECT_REF` in `config/app-variant.js` is the same ref.
The login also sees a second project in the same organisation, **"Hail-It"** (`uysrndvysyfiqfypwelo`), recorded in earlier session output. The accidental run could only reach the linked project (no suite names Hail-It). **Which project raised the Disk I/O warning cannot be determined locally**: that must be read from the warning email / dashboard.

## 3. Timeline (UTC = local time on this machine)
| Time | Event | Source |
|---|---|---|
| 15:25:11.955 | command launched (`ISOLATED_ONLY=funeral-privacy npm run test:isolated`, filter matched nothing) | session transcript; runner process start 3:25PM |
| 15:35:12 | tool timeout, run moved to background, still running | transcript |
| 15:36–15:44 | corrected, properly filtered local runs began; the accidental run continued unnoticed | transcript |
| 15:58:29 | `ps` shows the runner alive and a `supabase db query --linked` child (begin; create temp table r…) | transcript tool output |
| 15:58:39.483 | kill command issued | transcript |
| 15:58:39.679 | last `npx supabase db query --linked` invocation began (a read of `pg_proc` for `search_memories`, from `step14-hardening`) | `~/.npm/_logs/2026-10-31T15_58_39_679Z-debug-0.log` |
| ≈15:58:41.7 | `pkill -f "supabase db query"` after a 2 s sleep | transcript |
| 15:58:42 | output file closed | file mtime |
| 16:23 | process listing: no `node --test`, `isolated-pg`, `supabase` or `npx supabase` process; no non-loopback connection from node/npx | this investigation |

**Duration ≈ 33 min 30 s** (not "about 35"). npm keeps only the last ~10 logs, so a per-invocation count is not recoverable locally.

## 4. What ran
Node discovery order is alphabetical by path; the first 12 files match the recorded output exactly and the last query matches file **#223 of 283, `supabase/tests/step14-hardening.node.test.ts`**. So the run executed files #1–#222 completely and #223 partially (221 existing at the time, after excluding two files created later). 60 files after it did not run (`storage-buckets` onward).
Of the executed files: **61 use `--linked`** (≈470 query call sites; loops multiply some) plus 4 `service_key.txt` readers, 5 `.env` readers, 2 live-site fetchers.
Credentials: no `service_key.txt` and no `.env` in that worktree, no service-role variable in the environment, no test fetches keys through the CLI — **but `supabase db query --linked` does not use those**: it uses the logged-in CLI's access token (present in the macOS keychain), which is a project-level credential able to write.

### Classification of the 61 executed `--linked` files (static reading, not proven by execution)
* **Persistent writes by design — 2:** `booking-capacity-concurrency` and `booking-terminal-state` insert committed rows (autocommit, no transaction): a `ZZ Capacity Concurrency` / `ZZ Terminal State` business (slugs `zz-capacity-concurrency`, `zz-terminal-state`, inactive), their `book_services`, and `book_bookings` with real profile ids chosen by `order by id offset N` as owner/customer/stranger; they update booking statuses; they clean up in `after()` with `delete`s and assert "leaked into production = 0". Each `confirmed` booking insert fires `tg_ae_booking → analytics_emit('booking_confirmed', …)`, a **persistent analytics row that the cleanup does not delete**. Other triggers/notifications on those tables are NOT verified.
* **Transaction opened, no rollback or commit anywhere in the file — 16 (unverified):** `booking-metering`, `donation-history`, `event-discovery`, `event-payout-fallback`, `hub-donation-pretest`, `hub-membership-pretest`, `job-shift-boost`, `marketplace-readiness`, `membership-history-and-leave`, `membership-refunds`, `memory-media-privacy`, `mobile-ticket-payout`, `rate-limits`, `scheduled-jobs`, `shift-boost-pretest`, `shift-boost-purchase-history`. Each sends `begin;` + inserts/updates/function calls and ends with a plain `select`. Whether an unterminated `BEGIN` is discarded when the CLI's API request ends depends on the CLI/API and **cannot be established locally**. `rate-limits` calls `claim_rate_limits` (writes counters) and `booking-metering` calls `skip_bookings_for_metering` / `claim_bookings_for_metering` (side-effect functions) inside such a transaction.
* **Transaction with an explicit `rollback` — 23:** `ai-route-security`, `bookings-tier-entitlement`, `boost-refunds`, `business-be-found-and-next`, `business-column-privacy`, `business-effective-tier`, `card-removal`, `column-locks`, `commercial-terms-acceptance`, `commercial-terms-enforcement`, `commercial-terms-ux`, `directory-public-read`, `fetch-first-card`, `fetch-hold-expiry`, `fetch-price-lock`, `identity-binding`, `membership-checkout`, `mobile-business-home`, `offer-visibility`, `offers-loyalty-tier-entitlement`, `passes-tier-entitlement`, `products-tier-entitlement`, `security-reaudit`. They insert into `auth.users` (`@probe.invalid`), `local_businesses`, `compliance_log`, etc. and call side-effect functions (`record_commercial_terms_acceptance`, `claim_ai_request`, `claim_fetch_authorisation`, `update public.admin_config …`), designed to roll back. A rollback is present in the file; that every batch reached it is not proven (an error aborts the transaction, which is also discarded at session end — same caveat as above).
* **Read-only (catalog/aggregate selects) — 20:** e.g. `admin-refund-access`, `book-discovery-tier-entitlement`, `boost-history`, `business-boost-pretest`, `capability-entry-paywall`, `checkout-reference`, `event-order-management`, `pg-net-boundary`, `refund-reconciliation`, `selling-policy`, `storage-buckets`.
* **Other CLI use:** `edge-function-drift` runs `supabase functions list --project-ref <hard-coded ref>` (read) and `--linked` queries.
* **Live site / network:** `ai-route-security` (needs `.env`, absent → exited at once) and `step14-hardening` reference `https://oneshetland.com`; their requests, if made, are anonymous GETs/POSTs designed to be refused. Not verified which fired.
* **Service-key suites** (`fetch-*` ×4): read `service_key.txt` from the worktree root; absent, so they skip.
No `DROP`, `TRUNCATE`, `ALTER` or `CREATE` against `public` is issued by the executed files outside `pg_temp` objects, rollback-wrapped probes and (in `business-column-privacy`) a `create or replace function public.h7_try(...)` **inside a transaction** (rollback-wrapped; same caveat).

## 5. Confirmed vs possible vs unknown
* **Confirmed (from recorded output and logs):** the run contacted production-linked Supabase for ≈33.5 min; first 12 files completed in order; the last query was a `pg_proc` read.
* **Possible writes:** the two persistent suites (certain by design to have inserted and then deleted rows, plus left `booking_confirmed` analytics rows); the 16 unterminated transactions (unverified); the 23 rollback-wrapped probes (designed not to persist).
* **Cannot be established locally:** the exact queries issued and their count; whether each cleanup/rollback succeeded; whether any trigger beyond `ae_booking` emitted notifications or `pg_net` calls; whether the run changed production data at all; which project the Disk I/O warning belongs to.

## 6. Disk I/O Budget warning
No local record of the warning exists (no mention in memory or docs), so timing cannot be correlated here. The volume is modest (≈470+ short statements in 33 min; catalog reads, small-table counts, a handful of inserts/updates; `booking-capacity-concurrency` adds several concurrent sessions with `pg_sleep(2)`), so a contribution is **possible but unproven**; rolled-back writes still generate WAL/IO. Confounders: authorised production work earlier the same day (Stage 3A.1 deploy and read checks 00:32–01:51Z) and normal traffic.
Evidence needed from the dashboard (not queried by me): Reports → Database → **Disk IO / IOPS / throughput and "Disk IO consumption %" at 1-minute resolution for 15:00–16:30Z**; the warning's timestamp and project; Postgres logs for `_guard where false` statements (exact count and time span); Management-API / auth audit logs for database-query requests from the CLI token in that window; `pg_stat_statements` deltas; `pg_stat_user_tables` insert/update/delete deltas for `local_businesses`, `book_services`, `book_bookings`.

## 7. Production checks Darren (or an authorised person) should run, read-only
`local_businesses` where `slug in ('zz-capacity-concurrency','zz-terminal-state')` (expect 0); `book_services`/`book_bookings` of those businesses (expect 0); analytics events of type `booking_confirmed` created 15:25–15:59Z whose business no longer exists; `auth.users` with `email like '%@probe.invalid'` (expect 0); `compliance_log`, `admin_config` ('fees.fetch.fixed_pence' must be unchanged), `rate_limit_counters`/claims, `hub_*`, `shifts`, `jobs` rows created in the window; `notice_*` tables untouched. Compare row counts/`max(created_at)` with the window.

## 8. Safeguards now installed (local commit)
* This checkout is **unlinked** (`supabase/.temp/project-ref`, `linked-project.json`, `pooler-url` removed from git).
* `supabase/tests/_support/production-lane-guard.ts` is the **first import of 93 production-capable test files** (86 `--linked`, 4 `service_key.txt`, 3 `.env`/live-site readers); it throws unless `OS_ALLOW_PRODUCTION_PROBES` holds a written-approval phrase. Verified statically (all 93 first imports) and by importing the guard alone (it refuses). **No test was run.**
* `npm test`, `test:fixtures`, `test:all` now run `scripts/refuse-production-lane.mjs` (exit 2); the old lists are data in `scripts/production-lanes.json`.
* `scripts/isolated-pg.mjs` refuses an empty/unmatched `ISOLATED_ONLY`.
* Acceptance clients call `assertIsolated` (loopback only, no production marker in env, not linked).
* No npm lifecycle hooks, git hooks, CI or editor hooks exist that run tests (the only Claude hook plays a sound).

## 9. Remaining unsafe entry points (not fixed here)
1. **The other 22 worktrees and `oneshetland-delivers` itself remain linked** to production and have the same ~100 unguarded files and `npm test`. A bare `node --test` there repeats this incident. (Same for `oneshetland-attribution-main` etc.)
2. **The CLI credential is machine-wide** (keychain): any `supabase … --project-ref nkrtmakxygkvxuxriiil` (e.g. `edge-function-drift`, any script, any agent) works from any directory regardless of link files.
3. `scripts/generate-logos.mjs`, `scripts/import-cruise.mjs` (read `service_key.txt`/`.env`, write to production), SQL scripts `scripts/*.sql` (`seed-demo.sql`, `revert-driver-roles.sql`, `fix-work-categories.sql`, `install-*.sql`), and the `supabase db push|functions deploy|migration repair|secrets` commands in the runbooks.
4. Tests that read `.env` for a production URL/anon key (`gift-preview-security`, `owner-manage-cta`, `public-surface-contract`) are now guarded. `email-tables-lockdown`, `pass-immutability` and `notice-broadcast-eligibility` mention `.env`/service keys but are isolated-lane suites that require a local `PASS_PROOF_DSN` and refuse a Supabase DSN, so they were left unguarded.
5. `ui-proxy.mjs` (port 54790, demo backend) listens on the LAN address; local-only upstream, but reachable by other devices on the network.
6. Unrelated running processes left alone: two `trigger.dev mcp` servers (7 days old), `expo run:ios --configuration Release` and `eas device:create` (13 h).

## 10. Proposed fail-closed replacement (not implemented)
* One helper, `supabase/tests/_support/local-sql.ts`: requires `PASS_PROOF_DSN`, refuses non-loopback or any `supabase` host, runs `psql` itself, and wraps **every** statement batch in `begin; … rollback;` — no CLI, no `--linked`, no network.
* Replace "probe production" with **schema probes against an isolated cluster restored from a schema-only dump** taken once by a person, outside any agent run.
* If a production read is ever needed: a separate, explicitly named command using a **read-only database role** with `default_transaction_read_only = on` and a statement timeout, run by a human after written approval, never discoverable by `node --test`.
* CI/dev rule: `node --test` only with explicit file lists; keep production-capable files out of the discovery pattern (rename to `.probe.ts`) once the replacement exists.
* Unlink or remove CLI link files from every worktree except one deliberately named release checkout, and consider `supabase logout` for day-to-day sessions.

## 11. Recommended next action
Darren: (1) check the production items in §7 and the Disk I/O evidence in §6 (or authorise a specific read-only check); (2) decide whether to unlink the other worktrees and whether to log the CLI out; (3) tell me when to build the §10 replacement.
