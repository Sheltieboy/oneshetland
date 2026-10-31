# OneShetland Preview (private iPhone build)

A separate app that installs beside production and shares nothing with it. Production is `com.oneshetland.app`; nothing in this file changes it.

| | Production | Preview (both profiles) |
|---|---|---|
| iOS bundle id / Android package | `com.oneshetland.app` | `com.oneshetland.app.preview` |
| Name | OneShetland | OneShetland Preview |
| URL scheme | `oneshetland-fetch` | `oneshetland-preview` |
| Universal / app links for oneshetland.com | yes | **no** |
| EAS Update channel | `production` | `preview` / `preview-demo` |

All of this is decided in `config/app-variant.js` from `APP_VARIANT`, set per profile in `eas.json`. Unset means production, untouched. Pinned by `supabase/tests/app-variant.node.test.ts`.

## Profiles
- `preview-demo` — DEMONSTRATION. Talks only to the private fixture backend on the Mac (`supabase/tests/api/ui-fixture-env.sh`, `DEMO_LAN=1`): read-only, anonymous-only, fixture data only. EAS environment `development` (holds no variables), so no production URL, no Stripe key, no Maps key can enter. The build refuses a non-private backend or any Stripe key.
- `preview` — REAL DATA, read-only in practice: production Supabase, Stripe test key. Sign-in cannot complete (the website returns to `oneshetland-fetch://`, which belongs to production). Do not sign in.

Neither profile is submittable (`submit` has only `production`). Never run `eas update` for either channel without separate approval.

## Demonstration backend
    DEMO_LAN=1 bash supabase/tests/api/ui-fixture-env.sh start     # listens on the LAN: iPhone must be on the same Wi-Fi as the Mac
    PROXY_HOST=127.0.0.1 DEMO_LAN=1 bash ...                        # same logic, loopback only (testing)
    bash supabase/tests/api/ui-fixture-env.sh stop
The host name in `eas.json` (`<LocalHostName>.local`) must match the Mac's.

## Android
Android builds on EAS now fail at config time when no Maps key is present (`app.config.js`). The preview package name differs from production, so a Google key restricted to `com.oneshetland.app` will show blank map tiles in a preview Android build (no crash).
