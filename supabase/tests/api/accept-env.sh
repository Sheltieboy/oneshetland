#!/bin/bash
# accept-env.sh start|stop — a WRITABLE, throwaway acceptance-test backend for the Notices & Alerts work: Postgres 17.6 + the real GoTrue (password
# sign-in, JWTs) + PostgREST + a loopback-only gateway that routes /auth/v1 and /rest/v1 like the hosted API. Applies the ten notices migrations to the same
# reduced schema the demo uses, but loads NO demo content. Everything is bound to 127.0.0.1; nothing here can reach a hosted project. It is a separate set of
# containers, network and ports from the read-only demo backend (ui-fixture-env.sh, port 54790), which it never touches.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PG=notices-accept-pg; REST=notices-accept-rest; AUTH=notices-accept-auth; NET=notices-accept
SECRET='a-proof-only-secret-that-is-at-least-32-characters-long'
if [ "${1:-}" = "stop" ]; then
  [ -f /tmp/accept-gateway.pid ] && kill "$(cat /tmp/accept-gateway.pid)" 2>/dev/null || true
  docker rm -f $PG $REST $AUTH >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; exit 0
fi
docker network create $NET >/dev/null 2>&1 || true
docker rm -f $PG $REST $AUTH >/dev/null 2>&1 || true
docker run -d --name $PG --network $NET -e POSTGRES_PASSWORD=proofpw -p 127.0.0.1:54801:5432 public.ecr.aws/supabase/postgres:17.6.1.121 >/dev/null
for i in $(seq 1 60); do docker exec $PG pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
# :base in the SQL fixtures = where ui-proxy.mjs serves /demo-assets (the proxy's own origin: loopback unless PROXY_HOST / ASSET_BASE say otherwise)
ASSET_BASE="${ASSET_BASE:-http://${PROXY_HOST:-127.0.0.1}:54790}"
dpsql() { docker exec -i $PG psql -U "$1" -h localhost -d postgres -X -q -v ON_ERROR_STOP=1 -v base="$ASSET_BASE"; }
dpsql supabase_admin <<'SQL'
alter role authenticator with password 'proofpw';
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
SQL
dpsql postgres <<'SQL'
drop schema if exists public cascade; create schema public; grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated;
SQL
tail -n +16 supabase/tests/_support/attribution-prefix-schema.sql | dpsql postgres
dpsql postgres <<'SQL'
create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)); $$;
grant execute on function public.is_admin() to anon, authenticated, service_role;
grant execute on function public.is_hub_admin(uuid, uuid), public.is_hub_member(uuid, uuid) to anon, authenticated, service_role;
alter table notices add column lat numeric, add column lng numeric; alter table profiles add column display_name text, add column location_area text, add column deleted_at timestamptz, add column is_active boolean default true;
alter table hubs add column logo_url text, add column brand_color text, add column type text default 'community', add column description text, add column cover_url text, add column contact_email text, add column contact_phone text, add column website text, add column area text, add column join_mode text default 'open', add column memberships_enabled boolean default false, add column directory_enabled boolean default false, add column is_charity boolean default false, add column charity_number text, add column created_at timestamptz default now(); alter table local_businesses add column logo_url text, add column brand_color text;
alter table hub_campaigns add column raised_pence int default 0, add column goal_pence int default 0, add column donor_count int default 0, add column ends_at timestamptz, add column status text default 'active';
create policy "hub_campaigns read" on hub_campaigns for select using (true);
grant select on hub_campaigns to anon, authenticated;
alter table notices add constraint notices_campaign_id_fkey foreign key (campaign_id) references hub_campaigns(id) on delete cascade;
-- the public business view the app's business detail screen reads (lib/local-api.ts BUSINESS_PUBLIC_SOURCE), with just enough columns for the fixtures
alter table local_businesses add column category text, add column description text, add column address text, add column lat numeric, add column lng numeric, add column cover_url text,
  add column is_verified boolean default false, add column is_active boolean default true, add column is_claimed boolean default false, add column created_at timestamptz default now(),
  add column accepts_wallet boolean default false, add column accepts_bookings boolean default false, add column subscription_tier text, add column subscription_until timestamptz;
create view local_businesses_public as select id, name, category, description, address, lat, lng, logo_url, cover_url, brand_color, null::text[] as tags, null::text as phone, null::text as website,
  null::text as email, slug, null::jsonb as opening_hours, null::date as opening_hours_until, is_verified, is_active, is_claimed, null::timestamptz as claimed_at, null::timestamptz as verified_at, created_at,
  accepts_wallet, false as wallet_live, accepts_bookings, 0::numeric as cashback_percent, payout_enabled, subscription_tier, subscription_until, can_publish_urgent, null::boolean as planner_visitor_ready,
  null::int as planner_dwell_minutes, null::text as planner_setting, null::text[] as planner_good_for, null::text as planner_booking, null::text as planner_note, null::text as planner_context_source,
  null::text[] as trade_categories, null::text as trade_availability, null::timestamptz as trade_availability_set_at, null::int as trade_min_job_pence, null::jsonb as trade_credentials from local_businesses;
grant select on local_businesses_public to anon, authenticated, service_role;
create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
SQL
# production already has the shared rate limiter; apply it without its pg_cron schedule line
sed '/^-- Scheduled outside the transaction/,$d' supabase/migrations/20260821280000_rate_limits.sql | dpsql postgres
for m in 20261121000000_event_notice_attribution 20261127000000_canonical_geography_foundation 20261127010000_geography_alias_ambiguity 20261128000000_notices_structural_readiness 20261128010000_notices_read_protection 20261129000000_notices_alerts_publishers 20261129010000_notices_alerts_core 20261129020000_notices_alerts_audience 20261129030000_funeral_notices 20261129040000_notice_imports 20261129050000_member_notices 20261129060000_funeral_privacy 20261129070000_funeral_enquiry_protection; do dpsql postgres < supabase/migrations/$m.sql; done
dpsql postgres < supabase/tests/api/ui-site-schema.sql
# the existing production notification tables (shapes copied from the baseline / spine migrations): the delete-account function removes the member's rows from them
dpsql postgres <<'SQL'
create table if not exists notification_preferences (user_id uuid primary key, enabled boolean default true, notices_enabled boolean default true, hubs_enabled boolean default true, quiet_hours_start time, quiet_hours_end time, updated_at timestamptz default now());
create table if not exists push_tokens (id uuid primary key default gen_random_uuid(), user_id uuid not null, token text not null, created_at timestamptz default now());
grant select, insert, update, delete on notification_preferences, push_tokens to service_role, authenticated;
SQL
# the website's account query selects these profile columns (the reduced schema has no use for them otherwise)
dpsql postgres <<'SQL'
alter table profiles add column if not exists phone text, add column if not exists avatar_url text, add column if not exists bio text, add column if not exists onboarding_completed_at timestamptz,
  add column if not exists games_handle text;     -- the delete-account function scrubs these too
SQL
dpsql supabase_admin <<'SQL'
alter role supabase_auth_admin with password 'proofpw';
SQL
docker run -d --name $AUTH --network $NET -p 127.0.0.1:54803:9999 \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://127.0.0.1:54800 -e GOTRUE_SITE_URL=http://127.0.0.1:3111 \
  -e GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:3111/** -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:proofpw@$PG:5432/postgres" \
  -e GOTRUE_JWT_SECRET="$SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_SMTP_HOST=localhost -e GOTRUE_SMTP_PORT=2500 \
  -e GOTRUE_SMTP_ADMIN_EMAIL=accept@example.test -e GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 -e GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true \
  public.ecr.aws/supabase/gotrue:v2.197.0 >/dev/null
docker run -d --name $REST --network $NET -p 127.0.0.1:54802:3000 -e PGRST_DB_URI=postgres://authenticator:proofpw@$PG:5432/postgres -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" -e PGRST_DB_POOL=6 public.ecr.aws/supabase/postgrest:v14.5 >/dev/null
for i in $(seq 1 40); do curl -sf http://127.0.0.1:54803/health >/dev/null 2>&1 && break; sleep 1; done
ANON=$(node -e "const c=require('node:crypto');const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const h=b({alg:'HS256',typ:'JWT'}),p=b({iss:'accept',role:'anon',exp:Math.floor(Date.now()/1000)+86400*30});process.stdout.write(h+'.'+p+'.'+c.createHmac('sha256',process.argv[1]).update(h+'.'+p).digest('base64url'))" "$SECRET")
GW_AUTH=54803 GW_REST=54802 nohup node supabase/tests/api/accept-gateway.mjs > /tmp/accept-gateway.log 2>&1 & echo $! > /tmp/accept-gateway.pid
sleep 1
echo "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54800"; echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON"
