#!/bin/bash
# Runs notices-alerts-postgrest.node.test.ts against a throwaway Supabase-flavoured Postgres + PostgREST in Docker, for two PostgREST versions, then tears down.
# Separate container names / ports from run-notices-api.sh and the demonstration backend, so it can run beside them. Nothing here touches a hosted project.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGIMG=public.ecr.aws/supabase/postgres:17.6.1.121
# ports: base, base+1 (PostgREST), base+2 (proxy). The acceptance backend (accept-env.sh) uses 54801-54803, so run this one elsewhere with API_PORT_BASE=54811 when both are up.
export API_PORT_BASE="${API_PORT_BASE:-54801}"
docker network create notices-alerts-proof >/dev/null 2>&1 || true
docker rm -f notices-alerts-pg notices-alerts-rest >/dev/null 2>&1 || true
docker run -d --name notices-alerts-pg --network notices-alerts-proof -e POSTGRES_PASSWORD=proofpw -p 127.0.0.1:${API_PORT_BASE}:5432 "$PGIMG" >/dev/null
for i in $(seq 1 60); do docker exec notices-alerts-pg pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
status=0
for img in public.ecr.aws/supabase/postgrest:v14.5 postgrest/postgrest:v12.2.3; do
  echo "=== PostgREST $img"
  POSTGREST_IMAGE="$img" node --test supabase/tests/api/notices-alerts-postgrest.node.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖|PostgREST image" || status=1
done
docker rm -f notices-alerts-pg notices-alerts-rest >/dev/null 2>&1 || true
docker network rm notices-alerts-proof >/dev/null 2>&1 || true
exit $status
