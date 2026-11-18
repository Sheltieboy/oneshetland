# Editions Stripe test-mode verification harness

Proves the Editions payment behaviour in Stripe TEST mode while making it impossible for test events to reach production. **Nothing here has been run against the real account except read-only GETs** (webhook endpoint list, event destination list, account list).

## Safety properties
1. Test mode only: every Stripe call goes through `lib/stripe-cli.mjs` = the `stripe` CLI with `--project-name default`. Never `--live`, never `--api-key`, `STRIPE_API_KEY` is removed from the child environment, the CLI config file is never read, any response containing `livemode: true` aborts the run.
2. Webhook isolation: `webhook-guard.mjs` disables ONLY the endpoint ids in an approved-ids file, saves their complete original state (id, status, url, enabled_events, api_version, description, metadata, connect/application) BEFORE the first change, re-enables exactly those, re-reads and compares every field, and exits non-zero (loud) if anything differs. A PRODUCTION-host endpoint can never be on the allow list. v2 event destinations that cannot be read make the guard fail closed.
3. `run-with-guard.mjs` always restores (normal exit, command failure, SIGINT/SIGTERM/SIGHUP, uncaught error, a crash in the middle of `disable`). Only SIGKILL/power loss cannot be trapped: its state file path is printed first; recover with `restore-now`.
4. Every live scenario refuses to start unless `verify-isolated` passes, and refuses without an explicit `--account`.
5. The database is only the local container `editions-11-pg`; the edge functions run under Deno with `env -i`, `--allow-net=127.0.0.1`, `--cached-only`, read access to `supabase/functions` only, dummy `STRIPE_SECRET_KEY=sk_test_local_forwarder`, random local webhook secrets; any fetch to a non-loopback host is blocked inside the process.
6. Stripe objects created are tagged `metadata[oneshetland_test_run]=<run id>` (the forwarder adds it to every create; direct calls add it explicitly). Test clocks, subscriptions and customers are deleted at the end (`--keep` to skip). Payments, refunds, disputes and the E4 payout cannot be undone.

## Files
- `webhook-guard.mjs` `plan | disable | restore | verify-isolated`;  `run-with-guard.mjs` wrapper + `restore-now`
- `stripe-forwarder.mjs` loopback HTTP server standing in for api.stripe.com (whitelist, `--target cli|mock`, `--tag`, `--print-plan`)
- `run-functions-local.sh cache|start|stop`, `deno/host.ts` (fetch + Deno.listen wrapper; function sources are NOT edited)
- `scenarios/e0..e5`, `scenarios/lib/common.mjs`
- `test/` unit tests (`guard.test.mjs` uses a fake `stripe` executable; `forwarder.test.mjs`; `pure.test.mjs`)

## Forwarder limits (CLI target)
Idempotent replays are executed by Stripe but the CLI hides `Idempotent-Replayed`; `-d key=value` splits at the first `=` (bracketed keys and repeated `expand[]` pass through; an empty value unsets); GET parameters go as `-d`; CLI error text is parsed best-effort (JSON body plus `status=NNN`, else 502); each request is a process start (~0.5 s) and requests are serialised; the CLI may add its own User-Agent and idempotency key when none is given; `Stripe-Version` is passed with `--stripe-version`. Events fetched with `GET /v1/events` use the account's API version: E2/E5 check it is 2023-10-16 and warn if not.

## Run order (once the coordinator gives the go-ahead)
```
cd /Users/darrenfullerton/Claude/oneshetland-be-editions-11-release
T=scripts/stripe-testmode; ALLOW=/Users/darrenfullerton/Claude/safe-test/allow-endpoints.txt      # allow file: empty unless an endpoint may keep receiving
# 0. offline checks (no Stripe)
node --test $T/test/guard.test.mjs $T/test/forwarder.test.mjs
/Users/darrenfullerton/Claude/safe-test/run-safe.sh "$PWD" $T/test/pure.test.mjs
docker start editions-stripe-mock 2>/dev/null || docker run -d --rm --name editions-stripe-mock -p 127.0.0.1:12111:12111 stripe/stripe-mock:latest
for s in e0-package-orders e1-participation e2-memberships e3-refunds e4-disputes e5-webhooks-reconcile; do node --no-warnings $T/scenarios/$s.mjs --dry-run; done
# 0b. PRE-CHECK before any real window (type-checks the real functions; caught a swallowed-statement bug that unit tests missed)
for f in editions-commerce-cron editions-stripe-webhook create-edition-checkout; do DENO_DIR=/Users/darrenfullerton/Claude/safe-test/deno-cache ~/.deno/bin/deno check --no-lock supabase/functions/$f/index.ts || exit 1; done
# 1. plan (read-only) and Darren's decision
node $T/webhook-guard.mjs plan --allow $ALLOW
printf 'we_...\nwe_...\n' > /Users/darrenfullerton/Claude/safe-test/approved-ids.txt     # exactly the ids Darren approves
# 2. run everything under the guard (disable -> scenarios -> ALWAYS restore + verify)
node $T/run-with-guard.mjs --allow $ALLOW --approved /Users/darrenfullerton/Claude/safe-test/approved-ids.txt --state /Users/darrenfullerton/Claude/safe-test/state/run1.json -- \
  bash -c 'A=acct_1U44wUCRzxW6flqJ; for s in e0-package-orders e1-participation e2-memberships e3-refunds e4-disputes e5-webhooks-reconcile; do node --no-warnings '$T'/scenarios/$s.mjs --allow '$ALLOW' --account $A --skip-drain || exit 1; done'
# 3. manual recovery at any time
node $T/run-with-guard.mjs restore-now --state /Users/darrenfullerton/Claude/safe-test/state/run1.json
```
First time on a machine: `$T/run-functions-local.sh cache` (the only step that contacts deno.land / esm.sh). Local stack prerequisites: containers editions-11-pg/rest/auth running, `/tmp/editions-11.env`, migrations through `20270105000000` applied.
The scenarios start and stop their own forwarder and functions. Results are written to `/Users/darrenfullerton/Claude/safe-test/run/<run id>-<scenario>.json`.
Default account `acct_1U44wUCRzxW6flqJ` has zero balance, so E4 uses `--skip-drain` and the shortage case occurs naturally (E4 prints its debit_negative_balances setting and balance before/after). Without `--skip-drain`, E4 would drain the account with an irreversible test payout. E0 ignores `--account`. E2/E5 treat the 2023-10-16 event version as a WARNING.
