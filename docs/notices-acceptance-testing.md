# Notices & Alerts — signed-in acceptance testing (31 Oct 2026)

A writable, throwaway, **loopback-only** backend (nothing can reach a hosted project) with REAL authentication: Postgres 17.6 + the real GoTrue (password sign-in, JWTs, captcha off) + PostgREST + a small gateway that routes `/auth/v1` and `/rest/v1` like the hosted API. It applies the ten notices migrations to the same reduced schema the read-only demo uses, with **no demo content**. It is separate from the read-only demo backend (`ui-fixture-env.sh`, port 54790), which it never touches.

```bash
bash supabase/tests/api/accept-env.sh start              # ~2 min; prints NEXT_PUBLIC_SUPABASE_URL (127.0.0.1:54800) and the anon key
ACCEPT_ANON="$(...anon key...)" node supabase/tests/api/accept-seed.mjs   # nine fictional accounts, one hub, one business (password Accept-Test-1)
echo "<anon key>" > /tmp/accept-anon.txt
ACCEPT_RUN=1 node --test supabase/tests/api/accept-signed-in.node.test.ts  # 43 signed-in tests, every call made with that user's own JWT (RLS applies)
```
Run the acceptance suites ONE AT A TIME (they share one database; `node --test a b` runs files in parallel and they interfere): `accept-signed-in.node.test.ts` (49 tests) and `accept-delete-account.node.test.ts` (6 tests: executes the REAL `delete-account` function body against the backend and checks what is left).

Accounts (`<name>@accept.test`): `member`, `member2`, `hubowner`, `bizowner`, `official` (publisher of a verified organisation), `unverified` (publisher of an unverified one), `moderator`, `admin`, `funeralrep`.

Website against it (the real sign-in page works with Cloudflare's published always-pass test key):
```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54800 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx next dev -H 127.0.0.1 -p 3111
# fast account switching for testing: http://127.0.0.1:54800/__login/<name>?next=/notices/publish
```
Android emulator: `bash supabase/tests/api/accept-metro.sh start` (patches `metro.config.js` so the production-hosted Turnstile challenge is stubbed; `stop` restores the file with git; never committed), then sign in with the real form.

Stop everything: `bash supabase/tests/api/accept-env.sh stop`.

What the suite proves is listed in the acceptance report; what it cannot (real push, quiet-hours decisions, email, the deployed edge functions, a signed-in iPhone) is listed in `docs/notices-known-issues.md`.

## Funeral privacy and deletion (31 Oct 2026)
* Isolated database: `ISOLATED_ONLY=funeral-privacy npm run test:isolated` (43 tests). **Use a substring that matches a listed suite**: an unmatched filter used to fall through to `node --test` discovering every file; `scripts/isolated-pg.mjs` now refuses an empty selection.
* Real deletion path: `ACCEPT_RUN=1 node --test supabase/tests/api/accept-delete-account.node.test.ts` after `accept-env.sh start` and `accept-seed.mjs` (16 tests: every funeral state, memberships, administrators and moderators, partial failure and recovery, the production sequence).
* Run acceptance suites one at a time (shared database).

## Isolation guards (31 Oct 2026) — fail closed
* `supabase/tests/_support/isolation.ts`: every acceptance client calls `assertIsolated`, which refuses to run if (a) any URL is not loopback or names the production project / a hosted Supabase domain / the live site, (b) any environment variable naming a URL, host, DSN or site contains such a marker, or (c) the checkout is linked to a hosted Supabase project (`supabase/.temp/project-ref`). Pinned by `isolation-guard.node.test.ts`.
* This worktree is **unlinked** (`supabase/.temp/project-ref`, `linked-project.json`, `pooler-url` removed): `supabase ... --linked` has no project to reach. The ~100 older suites that use `--linked` therefore fail instead of querying production. Re-link deliberately, outside this checkout, only when a production check is intended.
* `scripts/isolated-pg.mjs` refuses an unmatched `ISOLATED_ONLY`. `npm test`, `test:fixtures`, `test:all` and a bare `node --test` must never be run in this worktree.
* The website for browser acceptance is started only through `supabase/tests/api/accept-web.sh` (loopback check, local anon key, service-role and payment variables unset).
* Browser sign-in: the production Turnstile gate was left untouched; the acceptance session installs a real local-GoTrue session cookie instead.
