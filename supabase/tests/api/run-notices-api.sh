#!/bin/bash
# Runs notices-postgrest.node.test.ts against a throwaway Supabase-flavoured Postgres + PostgREST in Docker, for two PostgREST versions, then tears everything down.
# Nothing here touches a hosted project. Requires Docker and the images below (docker pulls them on first use).
set -euo pipefail
cd "$(dirname "$0")/../../.."
PGIMG=public.ecr.aws/supabase/postgres:17.6.1.121
docker network create notices-api-proof >/dev/null 2>&1 || true
docker rm -f notices-proof-pg notices-proof-rest >/dev/null 2>&1 || true
docker run -d --name notices-proof-pg --network notices-api-proof -e POSTGRES_PASSWORD=proofpw -p 127.0.0.1:54781:5432 "$PGIMG" >/dev/null
for i in $(seq 1 60); do docker exec notices-proof-pg pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
status=0
for img in public.ecr.aws/supabase/postgrest:v14.5 postgrest/postgrest:v12.2.3; do
  echo "=== PostgREST $img"
  POSTGREST_IMAGE="$img" node --test supabase/tests/api/notices-postgrest.node.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖|PostgREST image|reads:" || status=1
done
docker rm -f notices-proof-pg notices-proof-rest >/dev/null 2>&1 || true
docker network rm notices-api-proof >/dev/null 2>&1 || true
exit $status
