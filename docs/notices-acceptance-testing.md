# Notices & Alerts — signed-in acceptance testing (31 Oct 2026)

A writable, throwaway, **loopback-only** backend (nothing can reach a hosted project) with REAL authentication: Postgres 17.6 + the real GoTrue (password sign-in, JWTs, captcha off) + PostgREST + a small gateway that routes `/auth/v1` and `/rest/v1` like the hosted API. It applies the ten notices migrations to the same reduced schema the read-only demo uses, with **no demo content**. It is separate from the read-only demo backend (`ui-fixture-env.sh`, port 54790), which it never touches.

```bash
bash supabase/tests/api/accept-env.sh start              # ~2 min; prints NEXT_PUBLIC_SUPABASE_URL (127.0.0.1:54800) and the anon key
ACCEPT_ANON="$(...anon key...)" node supabase/tests/api/accept-seed.mjs   # nine fictional accounts, one hub, one business (password Accept-Test-1)
echo "<anon key>" > /tmp/accept-anon.txt
ACCEPT_RUN=1 node --test supabase/tests/api/accept-signed-in.node.test.ts  # 43 signed-in tests, every call made with that user's own JWT (RLS applies)
```
Accounts (`<name>@accept.test`): `member`, `member2`, `hubowner`, `bizowner`, `official` (publisher of a verified organisation), `unverified` (publisher of an unverified one), `moderator`, `admin`, `funeralrep`.

Website against it (the real sign-in page works with Cloudflare's published always-pass test key):
```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54800 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx next dev -H 127.0.0.1 -p 3111
# fast account switching for testing: http://127.0.0.1:54800/__login/<name>?next=/notices/publish
```
Android emulator: `bash supabase/tests/api/accept-metro.sh start` (patches `metro.config.js` so the production-hosted Turnstile challenge is stubbed; `stop` restores the file with git; never committed), then sign in with the real form.

Stop everything: `bash supabase/tests/api/accept-env.sh stop`.

What the suite proves is listed in the acceptance report; what it cannot (real push, quiet-hours decisions, email, the deployed edge functions, a signed-in iPhone) is listed in `docs/notices-known-issues.md`.
