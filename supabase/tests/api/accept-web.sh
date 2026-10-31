#!/bin/bash
# accept-web.sh — starts the WEBSITE (dev server, port 3011) against the local acceptance backend ONLY. Refuses to start unless the backend URL is loopback and no
# production marker is in the environment. Run accept-env.sh start + accept-seed.mjs first.
set -euo pipefail
cd "$(dirname "$0")/../../.."
WEB="${WEB_DIR:-$(cd .. && pwd)/oneshetland-web-notices-alerts}"
URL="${ACCEPT_URL:-http://127.0.0.1:54800}"
node --input-type=module -e "
import { assertIsolated } from './supabase/tests/_support/isolation.ts';
assertIsolated({ ACCEPT_URL: process.argv[1] });
" "$URL"
[ -f /tmp/accept-anon.txt ] || { echo "run accept-env.sh start first"; exit 1; }
export NEXT_PUBLIC_SUPABASE_URL="$URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$(cat /tmp/accept-anon.txt)" NEXT_PUBLIC_SITE_URL="http://localhost:3011"
unset SUPABASE_SERVICE_ROLE_KEY STRIPE_SECRET_KEY POSTMARK_SERVER_TOKEN RESEND_API_KEY 2>/dev/null || true
cd "$WEB"
exec npm run dev -- -p 3011
