# Test safety (Fetch v2, Step 13)

- `production.mjs` — what "production" is: the project ref, its hosts and pooler login, live Stripe keys, push/Google/website hosts;
  which child processes reach or change a live service; which SQL is not a plain read. Pure; tested by `supabase/tests/test-safety.node.test.ts`.
- `guard.mjs` — loaded into every test process (`NODE_OPTIONS=--import`). Refuses a production environment at start-up; refuses
  sockets/fetches/child processes that would reach a live service, before they connect; re-arms itself in every child; logs each refusal.
- `env.mjs` — the allow-listed environment every lane starts tests in.
- `inventory.mjs` — static inventory of which suites can reach production (source of `supabase/tests/PRODUCTION-ACCESS.md`).
- `fresh-worktree-check.mjs` — the mandatory check: a brand-new worktree, your real shell, `npm test` — nothing may leave the machine.

If you were sent here by a `[test-safety] BLOCKED` line: a test tried to reach a live service. Do not loosen the guard. Mock the call,
move the proof to the isolated lane (`scripts/isolated-pg.mjs`), or — for a genuine read-only production check — add the suite to
`supabase/tests/lanes.json` `productionReadonly` and run it with `npm run test:integration:production-readonly`. See
`supabase/tests/README.md`.
