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
Edge Function secrets: `TURNSTILE_SECRET_KEY` (the sign-in widget's secret), `TURNSTILE_ALLOWED_HOSTNAMES` (`oneshetland.com,www.oneshetland.com`), `FUNERAL_ENQUIRY_ALLOWED_ORIGINS` (`https://oneshetland.com,https://www.oneshetland.com`), `FUNERAL_ENQUIRY_IP_SALT` (long random, never reused). Website: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` already exists; leave `NEXT_PUBLIC_TURNSTILE_SCRIPT_URL` UNSET in production (only loopback overrides are honoured anyway). The Turnstile widget's allowed domains must include the site. Deploy order: migrations (incl. `…070000`; needs `20260821280000_rate_limits`) → deploy the function → release the website, together (the old page called PostgREST and stops working once anon is revoked). **The release checks in "Client address trust" below MUST pass before launch: hosted behaviour is NOT yet verified.**

## Local testing
`supabase/tests/api/accept-funeral-enquiry-protection.node.test.ts` (28 tests: real handler, mocked Cloudflare `_mock-turnstile.ts` which refuses every non-loopback host, isolated backend), isolated DB tests in `notices-alerts-funeral-privacy`, web tests in `tests/notices-alerts.test.mjs`. The local gateway hosts the function and a mock widget script (`/__mock/turnstile.js`) so the browser never loads the live Turnstile script; `x-test-client-ip` (gateway only) simulates other visitors.


## Client address trust (reviewed 31 Oct 2026)
**What the limiter keys on:** ONE header, `cf-connecting-ip`, read as a single address. `x-forwarded-for` and every other header are never used (a fallback to the last `x-forwarded-for` entry that existed in the first version was removed: its first entry is client-supplied and its last could be one of the platform's own proxy hops, which would put every visitor in one bucket).

**What the code does (tested locally, offline and against the isolated backend):**
* header absent, only `x-forwarded-for` present, malformed, several comma-joined values, out-of-range, with a port, octal-looking (`010.0.0.1`), IPv6 with no usable /64 (`::`, `::1`, `::a.b.c.d`) or oversized → **503, no limiter claim, no Cloudflare call, nothing stored**, log code `client_address_untrusted`. (It used to answer 400 "verification failed", which blamed the visitor for a platform fault.)
* IPv4 is keyed in canonical dotted decimal. IPv4-mapped (`::ffff:a.b.c.d`, `::ffff:aabb:ccdd`) and NAT64 (`64:ff9b::/96`) addresses are keyed by the embedded IPv4 address (previously the hex forms collapsed into one shared bucket).
* IPv6 is keyed by its /64: all spellings (compressed, expanded, upper case, bracketed, zone id) of one /64 give one key; a different /64 gives a different key; the low 64 bits never matter.
* A forged `x-forwarded-for` can neither create a new identity nor merge two visitors. The key is `HMAC-SHA256(salt, normalised address)` (128 bits); the raw address goes only to Cloudflare as `remoteip`.
Accepted sharing: visitors behind one IPv4 address (office, carrier-grade NAT, VPN exit) share an identity. The per-client allowances (6/hour, 12/day, 3 per announcement) were chosen with that in mind; a refused family is told to try later or telephone.

**What is NOT established (needs a deployment):**
1. Whether the hosted Supabase edge sets `cf-connecting-ip` on requests reaching an Edge Function at all.
2. Whether it OVERWRITES a client-supplied `cf-connecting-ip` (if it passes a forged value through, an attacker could rotate it to escape every per-client limit).
Evidence found, none of it conclusive: Supabase's documentation says nothing about client-address headers on Edge Functions; the only staff answer (2022) says `x-forwarded-for` is populated and reads its FIRST entry, which is attacker-controllable; an unanswered 2025 community thread about the PostgREST path reports a client-sent `x-forwarded-for: spoofed` arriving as `spoofed,<real address>` with `cf-connecting-ip` holding the real address (not Edge Functions, not official). Cloudflare documents that it APPENDS to `X-Forwarded-For` and recommends `CF-Connecting-IP`, but does not explicitly say a client-sent `CF-Connecting-IP` is replaced. The local gateway REPLACES the header itself, so local tests cannot answer either question.

### Release verification (must be run on the deployed function; not yet done)
Use a staging Supabase project if one exists, otherwise production immediately before launch with your own networks. The checks need NO valid Turnstile token (the per-client attempt cap runs before verification; the first 20 attempts per address make an ordinary Cloudflare call with an invalid token and are refused; nothing is stored). Send valid-shaped bodies (a real announcement id, 5+ character message and contact) with `origin: https://oneshetland.com` and `turnstile_token: x`.
* **A. Forged header is overwritten (blocks release if it fails):** from ONE network send 25 requests, each with a different `cf-connecting-ip: 203.0.113.<n>`. Expect requests 1–20 → 400 `verification_failed`, requests 21–25 → **429**. If 21–25 are not 429 the platform passes the forged header through: the limiter is bypassable: DO NOT RELEASE.
* **B. Header present at all (blocks release if it fails):** the same run must NOT return 503 `unavailable` for every request. If it does, the platform sends no `cf-connecting-ip` (look for `client_address_untrusted` in the function logs); decide a fallback only after inspecting the headers the platform really supplies, with a test like A.
* **C. Forged `x-forwarded-for` is irrelevant:** repeat A with a fixed address header absent from the client and `x-forwarded-for: 198.51.100.<n>` rotating; the 21st request is still 429 (identity comes from the platform, not from the forged header).
* **D. Visitors are distinguished (blocks release if it fails):** after network 1 is at 429, send one request from a different network (phone data vs home broadband): it must return 400 `verification_failed`, not 429 or 503.
* **E. IPv6 (if available):** from an IPv6 network, 20 then 429; reconnecting with a new temporary address inside the same /64 stays limited.
* **F. Logs/data:** function logs hold only codes (no address, token or message); `rate_limits` subjects match `ip:<32 hex>` / `ipa:…` / `ann:…` / `global`. Test counters expire after 10 minutes; wait before real traffic.
Record the date, method and outcome of A–F in `docs/notices-known-issues.md` before release.
