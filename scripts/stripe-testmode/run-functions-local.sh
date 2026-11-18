#!/bin/bash
# run-functions-local.sh: run the REAL create-edition-checkout, editions-stripe-webhook and editions-commerce-cron locally under Deno, against the LOCAL stack only.
#   run-functions-local.sh cache                       one-off: fill the Deno cache (the ONLY step that contacts deno.land / esm.sh); afterwards everything runs --cached-only
#   run-functions-local.sh start <forwarder-url> [run-dir]   start the three functions (each in its own Deno process, ports printed); secrets go to <run-dir>/secrets.env (mode 600), never printed
#   run-functions-local.sh stop [run-dir]
# Every Deno process: `env -i` (clean environment), --no-prompt --cached-only, --allow-net=127.0.0.1 ONLY, --allow-env for a fixed list of names, --allow-read for the functions directory ONLY,
# no write, no run, no ffi. STRIPE_SECRET_KEY is the dummy `sk_test_local_forwarder`; the webhook secrets are freshly generated random local values; api.stripe.com is redirected to the forwarder
# by deno/host.ts (a fetch wrapper), without editing any function source.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
DENO="${DENO:-$HOME/.deno/bin/deno}"; export DENO_DIR="${DENO_DIR:-/Users/darrenfullerton/Claude/safe-test/deno-cache}"
ENVF="${EDITIONS_LOCAL_ENV:-/tmp/editions-11.env}"
FUNCS=(create-edition-checkout editions-stripe-webhook editions-commerce-cron)
BASEPORT="${EDITIONS_FUNCTIONS_BASE_PORT:-54931}"
cmd="${1:-}"; shift || true
case "$cmd" in
  cache)
    mkdir -p "$DENO_DIR"
    for f in "${FUNCS[@]}"; do "$DENO" cache --no-lock "$REPO/supabase/functions/$f/index.ts"; done
    "$DENO" cache --no-lock "$HERE/deno/host.ts" "$HERE/deno/prefetch.ts"; echo "cache filled in $DENO_DIR (later runs use --cached-only)";;
  start)
    FWD="${1:?forwarder url}"; RUN="${2:-/Users/darrenfullerton/Claude/safe-test/run/$(date +%Y%m%d-%H%M%S)}"
    [[ "$FWD" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || { echo "forwarder url must be http://127.0.0.1:<port>"; exit 2; }
    mkdir -p "$RUN"; chmod 700 "$RUN"
    set -a; source "$ENVF"; set +a                       # LOCAL-only values; never echoed
    [[ "$NEXT_PUBLIC_SUPABASE_URL" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || { echo "the Supabase URL is not loopback: refusing"; exit 2; }
    SUPABASE_JWT_SECRET="$SUPABASE_JWT_SECRET" node "$HERE/lib/mint-service-key.mjs" --out "$RUN/service.jwt"
    { echo "EDITIONS_STRIPE_WEBHOOK_SECRET=whsec_local_$(openssl rand -hex 24)"; echo "EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET=whsec_local_$(openssl rand -hex 24)"; } > "$RUN/secrets.env"; chmod 600 "$RUN/secrets.env"
    set -a; source "$RUN/secrets.env"; set +a
    i=0; : > "$RUN/ports.env"
    for f in "${FUNCS[@]}"; do
      port=$((BASEPORT + i)); i=$((i+1))
      ( env -i PATH=/usr/bin:/bin DENO_DIR="$DENO_DIR" HOME=/nonexistent NO_COLOR=1 \
          SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$(cat "$RUN/service.jwt")" \
          STRIPE_SECRET_KEY=sk_test_local_forwarder EDITIONS_STRIPE_WEBHOOK_SECRET="$EDITIONS_STRIPE_WEBHOOK_SECRET" EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET="$EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET" \
          FUNCTION="$f" FUNCTION_PORT="$port" STRIPE_FORWARDER_URL="$FWD" \
        "$DENO" run --no-prompt --cached-only --no-lock \
          --allow-net=127.0.0.1 \
          --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,STRIPE_SECRET_KEY,EDITIONS_STRIPE_WEBHOOK_SECRET,EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET,FUNCTION,FUNCTION_PORT,STRIPE_FORWARDER_URL \
          --allow-read="$REPO/supabase/functions,$HERE/deno" \
          "$HERE/deno/host.ts" > "$RUN/$f.log" 2>&1 & echo $! > "$RUN/$f.pid" )
      echo "$f=http://127.0.0.1:$port" >> "$RUN/ports.env"
    done
    for n in $(seq 1 100); do ok=1; for f in "${FUNCS[@]}"; do grep -q "listening" "$RUN/$f.log" 2>/dev/null || ok=0; done; [ $ok = 1 ] && break; sleep 0.2; done
    [ $ok = 1 ] || { echo "functions did not start; see $RUN/*.log"; "$0" stop "$RUN" || true; exit 1; }
    echo "RUN_DIR=$RUN"; cat "$RUN/ports.env";;
  stop)
    RUN="${1:?run dir}"; for f in "${FUNCS[@]}"; do [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null || true; done; echo stopped;;
  *) echo "usage: $0 cache | start <forwarder-url> [run-dir] | stop <run-dir>"; exit 1;;
esac
