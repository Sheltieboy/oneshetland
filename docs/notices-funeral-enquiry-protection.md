# Funeral enquiry form — spam protection (31 Oct 2026)

STATUS: implemented and tested LOCALLY (isolated backend, mocked Cloudflare). **Nothing is deployed, applied or configured in production.**

## The vulnerability that was fixed
1. `submit_funeral_enquiry` was callable by `anon` directly through PostgREST, so the page's honeypot and validation could be skipped by a script.
2. Its quotas were shared: 3 per announcement per day and 20 per hour for the WHOLE site. 3 scripted calls locked one family out of an announcement; 20 locked every family out for an hour.

## Architecture
`browser → Edge Function submit-funeral-enquiry → submit_funeral_enquiry (service role) → staff queue (unchanged)`
* `supabase/functions/_shared/funeral-enquiry.ts` (handler), `_shared/turnstile-verify.ts` (Cloudflare siteverify), `submit-funeral-enquiry/index.ts` (Deno wrapper), `verify_jwt = false` in `config.toml` (visitors are signed out; the function is the boundary).
* Order of checks: configuration present → origin allowed → input valid (cheap) → honeypot → trusted client key → cheap per-client attempt cap → **Turnstile verified by Cloudflare from the server** → per-client limits → shared limits → database function (which repeats its own backstops).
* **Fail closed:** missing secret/hostnames/origins/salt/service key → 503; Cloudflare unreachable, 5xx, malformed or wrong-secret → 503 ("not sent, try again"); limiter unreachable → 503; no client address → refused.
* **Token checks:** present; ≤2048 chars; Cloudflare `success`; `timeout-or-duplicate` → expired/reused; hostname must be in `TURNSTILE_ALLOWED_HOSTNAMES`; `action` must be `funeral-enquiry`; `cdata` must equal the announcement id (a token cannot be used for another announcement); `challenge_ts` not older than 5.5 minutes.
* **PostgREST bypass closed:** migration `20261129070000` revokes `submit_funeral_enquiry` from `public`, `anon`, `authenticated`; only `service_role` (the function) can call it. The website no longer names the function anywhere (allow-list entry and server action removed).
* **Website:** `FuneralEnquiryForm` shows the existing Turnstile widget (action + announcement bound), posts to the function, keeps every typed value on any failure, resets the single-use token after each attempt, and maps server codes to safe messages. Same styling, confirmation text, reference and privacy copy; mobile checked. The Android app is unchanged (it still opens the same web page).

## Rate limits (ceilings live in `rate_limit_policies`; one client address = a keyed hash of its IPv4, or of the IPv6 /64)
| Action | Window | Max | Scope | Why |
|---|---|---|---|---|
| `funeral_enquiry_ip_attempt` | 10 min | 20 | per client, **before** Cloudflare is called | garbage/failed checks cannot be unlimited or cost Cloudflare calls; a shared office or mobile address rarely needs more |
| `funeral_enquiry_ip_hour` | 1 h | 6 | per client, verified | several corrections in a sitting is well under it |
| `funeral_enquiry_ip_day` | 24 h | 12 | per client, all announcements | caps what one client can ever spend of any shared allowance |
| `funeral_enquiry_ip_announcement` | 24 h | 3 | per client per announcement | the old per-announcement ceiling, now charged to the client that used it |
| `funeral_enquiry_announcement` | 24 h | 15 | **shared** per announcement | reached only by clients that passed their own limits; one client adds ≤3, so filling it needs 5+ distinct verified clients |
| `funeral_enquiry_global` | 1 h | 300 | **shared** site-wide breaker | not a family quota; one client adds ≤6/h, so tripping it needs 50+ distinct verified clients |
| DB backstops | 24 h / 1 h | contact 3; announcement 30; site 600 | in `submit_funeral_enquiry` | defence in depth if another trusted caller is ever added; the same contact cannot be filed more than 3×/day |
Per-client claims are made BEFORE shared ones, so an abuser is stopped by its own allowance and never spends a shared one. Contact details are **not** used as a client identity (only the DB's per-contact backstop looks at them).
Residual risk (cannot be removed, only made expensive): an attacker with many addresses AND a solved Turnstile challenge for each can still fill an announcement's shared 15/day; staff still see every genuine request that arrives, and the website shows the telephone route.
**Privacy:** the address is never stored: only `HMAC-SHA256(salt, address)` truncated to 128 bits as a limiter subject, with a counter, purged after 2 days by the existing `purge_rate_limits` job. Logs contain outcome codes only (no token, contact, message or address; tested).

## Production configuration required (NOT done)
Edge Function secrets: `TURNSTILE_SECRET_KEY` (the sign-in widget's secret), `TURNSTILE_ALLOWED_HOSTNAMES` (`oneshetland.com,www.oneshetland.com`), `FUNERAL_ENQUIRY_ALLOWED_ORIGINS` (`https://oneshetland.com,https://www.oneshetland.com`), `FUNERAL_ENQUIRY_IP_SALT` (long random, never reused). Website: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` already exists; leave `NEXT_PUBLIC_TURNSTILE_SCRIPT_URL` UNSET in production (only loopback overrides are honoured anyway). The Turnstile widget's allowed domains must include the site. Deploy order: migrations (incl. `…070000`; needs `20260821280000_rate_limits`) → deploy the function → release the website, together (the old page called PostgREST and stops working once anon is revoked). Confirm the function sees the visitor address in `cf-connecting-ip` on the hosted platform before launch (assumed, not verified).

## Local testing
`supabase/tests/api/accept-funeral-enquiry-protection.node.test.ts` (28 tests: real handler, mocked Cloudflare `_mock-turnstile.ts` which refuses every non-loopback host, isolated backend), isolated DB tests in `notices-alerts-funeral-privacy`, web tests in `tests/notices-alerts.test.mjs`. The local gateway hosts the function and a mock widget script (`/__mock/turnstile.js`) so the browser never loads the live Turnstile script; `x-test-client-ip` (gateway only) simulates other visitors.
