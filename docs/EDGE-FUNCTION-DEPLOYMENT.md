# Edge Function deployment — the production manifest and the drift guard

Production runs each function from the bundle it was last deployed with, and **those bundles do not all contain the same copy of
`supabase/functions/_shared/*`** (58 of 100 functions bundle at least one older shared file; for example `rate-limit.ts` exists in two
versions across production). That is intentional: functions were deployed as exact deltas so unrelated shared changes did not ship.
Deploying a function re-bundles the CURRENT source and can therefore silently change its shared helpers.

## What records the truth

`supabase/production/edge-function-manifest.json` — per function: deployed version, `verify_jwt`, the sha256 of every file in the bundle
production runs, a classification (`canonical-current` = the bundle equals this source; `intentional-shared-drift` = the function's own
files match but some `_shared` file in production's bundle differs from the source here), and the list of drifting files.
No secrets, no environment values. `supabase/tests/edge-function-manifest.node.test.ts` fails if the source and the manifest disagree.

## Before every deploy

```bash
node scripts/check-function-deploy.mjs <function>
```

* exit 0 — only the function's own files change, or every shared change is acknowledged;
* exit 2 — shared files would change; each is listed (changed / added / removed). Review the diff of every file, then re-run with
  `--ack _shared/a.ts,_shared/b.ts` naming exactly those files (an acknowledgement of a file that is not changing is refused);
* exit 1 — unknown function, or `config.toml` `verify_jwt` disagrees with production.

Deploy only after a clean pass. Use one Supabase CLI process at a time.

## After a reviewed deploy

Download the bundles read-only and regenerate the manifest:

```bash
supabase functions list --project-ref nkrtmakxygkvxuxriiil -o json > /tmp/fns.json
# for each function (one at a time):  mkdir -p /tmp/dl/<fn>/supabase && cp supabase/config.toml /tmp/dl/<fn>/supabase/ \
#   && (cd /tmp/dl/<fn> && supabase functions download <fn> --use-api)
node scripts/function-manifest.mjs generate --bundles /tmp/dl --list /tmp/fns.json
node scripts/function-manifest.mjs verify
```

Commit the manifest change with the code change. Never mass-redeploy functions merely to standardise shared files.

`config.toml` carries the live `verify_jwt` split (88 true / 12 false); a deploy from a tree whose config disagrees would change it.
