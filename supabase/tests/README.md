# Test suites

**No ordinary test command can reach production.** That has been true since Fetch v2 Step 13 (25 Oct 2026). Before it, `npm test`
deliberately queried the linked production project and `test:fixtures` committed real rows there; see "History" below.

| Command | What it runs | What it may reach |
|---|---|---|
| `npm test` | The **safe offline lane**: every suite in `lanes.json` `offline` (Fetch v2 unit, contract and parity tests, navigation and UI logic, privacy and static guards, offline mocks, the guard's own tests) | **Nothing outside this machine.** |
| `npm run test:isolated` | The **isolated-database lane**: `scripts/isolated-pg.mjs` builds a throwaway PostgreSQL 17 on a unix socket, runs its suites, destroys it | That local cluster only |
| `npm run test:integration:production-readonly` | The **opt-in production read-only lane**: only the suites in `lanes.json` `productionReadonly` | Production **reads** only, after you opt in (below) |
| `npm run test:quarantined` | Nothing. Lists the write-capable production suites and why they are quarantined | — |
| `npm run test:all` | `npm test` then `npm run test:isolated` | as above |

## The guard

Every lane starts its tests through `scripts/test-lanes.mjs` (or `scripts/isolated-pg.mjs`) in a **clean environment** built from an
allow-list: Supabase, Stripe, Expo, Google and database variables in your shell never reach a test. `scripts/test-safety/guard.mjs` is
loaded into **every** test process and every child process they start (`NODE_OPTIONS=--import`). Before anything connects, it refuses:

- an environment that points at production or holds live credentials (the process exits 78 before any test runs);
- any socket or `fetch()` to a host other than localhost / a unix socket: hosted Supabase, Stripe, Expo push, Google, the live website;
- child processes that act on the linked project or a live host: `supabase … --linked`, `db push`, `functions deploy`, `secrets`,
  `link`, `psql`/`pg_dump` to a remote host, `curl`/`wget` to a live host, EAS build/submit/update.

Production is identified positively (`scripts/test-safety/production.mjs`): the project ref, its API and database hosts, the pooler login,
live Stripe key prefixes, and the push, Google and website hosts. Every refusal is printed with the suite that caused it, and the runner's
summary counts them. **A blocked attempt fails `npm test`** even if every assertion passed.

A fresh worktree of this repository is linked to the production project through the tracked `supabase/.temp/project-ref`. That link no
longer matters to tests: the guard refuses `--linked`, and `npm test` was proven safe from a fresh worktree (Step 13; run
`node scripts/test-safety/fresh-worktree-check.mjs` before merging changes to the lanes).

## The baseline, and what is expected on a branch

`npm test` reports these groups, so nobody has to guess:

1. **safe offline tests** — pass/fail counts;
2. **external access attempts blocked** — should be 0;
3. **known baseline failures** — `baseline/offline.json`: the failures this same lane produces on an untouched checkout of the commit
   this branch grew from (`lanes.json` `base`: Build 148 `7317508` for the app branch `fetch-v2-mobile`; `origin/main` `312f7fc` for
   the backend branch `fetch-v2`). They are pre-existing and not caused by Fetch v2. They are listed, and they do not fail the run;
4. **expected on this branch** — `lanes.json` `expectedOnBranch`: a named failure with the condition that ends it (on `fetch-v2`, the
   migration-history guard correctly reports the Fetch v2 migrations as unapplied until they are deployed);
5. **NEW failures** — anything else. These fail the run;
6. baseline or expected entries now passing, or for tests that no longer exist — prune them.

Never add an entry to hide a new failure.

## The opt-in production read-only lane

```
ONESHETLAND_ALLOW_PRODUCTION_READS=yes npm run test:integration:production-readonly
```

No script, CI job or `.env` sets that variable; you type it for one command. The runner prints a warning, refuses any suite that is not on
the read-only allow-list, and refuses any suite whose source contains write SQL or a write HTTP method. The guard then allows exactly
two things — `supabase db query --linked` whose SQL is a plain read (the session is also forced `default_transaction_read_only = on`, so
Postgres itself refuses a write hidden in a function), and `GET`/`HEAD` to the production REST API — and keeps Stripe, Expo, Google and
the website blocked.

## The quarantine

`lanes.json` `quarantined` lists every suite that can write to production: inside a transaction that is rolled back (class **E**), or
through the API, the service-role key or auth, or by committing fixture rows (the old `test:fixtures` lane) (class **D**). A rolled-back
transaction is not a safety boundary: it relied on every run reaching its `rollback`, on the CLI's login, and on nobody adding a
statement Postgres cannot roll back. These suites run nowhere until they are ported to the isolated lane, mocked, or rewritten as
read-only assertions. `PRODUCTION-ACCESS.md` lists every production-capable suite, how it reaches production and its class.

## Where every suite lives

`lanes.json` is the single list: `offline`, `productionReadonly`, `quarantined`, `excluded` (with a reason), `isolated` (mirrors
`scripts/isolated-pg.mjs`) and `unregisteredAtBase` (suites that were in no lane at the base commit — recorded, not run, and the list
may not grow). `test-registration.node.test.ts` fails if a suite on disk is in none of these, or in two of them, or if the offline lane
contains a suite that has a way to reach a hosted service.

## History

Until Step 13, `npm test` was the **routine** suite and ran against the linked production project ("read-only or wrapped in a
transaction that is never committed"), and `npm run test:fixtures` built and removed real rows in production for concurrency proofs. On
2026-09-08 a fixture proof left fabricated money on a real account; during an earlier launch-readiness audit a wallet appeared and
vanished mid-audit; during Fetch v2 Step 12 an "offline" run queried production through 31 linked suites before it was stopped (all of
their writes inside rolled-back transactions). The concurrency proofs moved to the isolated lane after 2026-09-08
(`production-concurrency-proofs`, `wallet-concurrency`). Step 13 closed the rest: the routine lane is offline, the fixture lane is gone,
and the guard makes the mistake impossible to repeat by accident.
