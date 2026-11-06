-- fetch-safety-pause.verify.sql — ROLLED-BACK verification against the real production schema using REAL role impersonation (no accounts created, nothing committed).
-- Run:  supabase db query --linked -f supabase/tests/fetch-safety-pause.verify.sql      (it ends in ROLLBACK; before AND after the migration is applied)
-- Output: one JSON object of named checks. Every value beginning "PASS" is expected; the file is safe to re-run any time.
begin;
create temp table r(k text, v text); grant all on r to public;
create temp table actors as select
  (select dp.id from driver_profiles dp where dp.driver_status = 'approved' and not exists (select 1 from delivery_requests d where d.customer_id = dp.id and d.status = 'pending') order by dp.id limit 1) as stranger_driver,
  (select customer_id from delivery_requests where status = 'pending' order by created_at limit 1) as pending_owner,
  (select run.driver_id from runs run join delivery_requests d on d.run_id = run.id where d.status = 'delivered' limit 1) as assigned_driver,
  (select id from profiles where role = 'admin' order by id limit 1) as admin,
  (select id from driver_profiles where driver_status = 'pending' limit 1) as pending_applicant,
  (select id from delivery_requests where status = 'pending' order by created_at limit 1) as a_pending_request;
grant select on actors to public;
insert into r select 'migration_applied', (to_regprocedure('public.fetch_is_open()') is not null)::text;

-- ── what each actor can read ────────────────────────────────────────────────────────────────────────────────────────
set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', (select stranger_driver from actors), 'role', 'authenticated')::text, true);
insert into r select 'stranger_approved_driver_sees_pending_rows', count(*)::text from delivery_requests where status = 'pending';
insert into r select 'stranger_approved_driver_can_read_a_phone_or_address', count(*)::text from delivery_requests where status = 'pending' and (contact_phone is not null or destination_address is not null or pickup_location is not null);
reset role; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', (select pending_owner from actors), 'role', 'authenticated')::text, true);
insert into r select 'customer_still_sees_own_pending', (count(*) >= 1)::text from delivery_requests where status = 'pending';
insert into r select 'customer_sees_only_own', (count(*) filter (where customer_id <> (select pending_owner from actors)) = 0)::text from delivery_requests;
reset role; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', (select assigned_driver from actors), 'role', 'authenticated')::text, true);
insert into r select 'assigned_driver_still_sees_own_job', (count(*) filter (where status = 'delivered') >= 1)::text from delivery_requests;
insert into r select 'assigned_driver_sees_no_unassigned_pending', (count(*) filter (where status = 'pending') = 0)::text from delivery_requests;
reset role; set local role anon; select set_config('request.jwt.claims', '{"role":"anon"}', true);
insert into r select 'anon_sees_no_requests', count(*)::text from delivery_requests;
insert into r select 'anon_info_rpcs_return_nothing', (public.get_customer_info_for_request((select a_pending_request from actors)) is null and public.get_driver_info_for_request((select a_pending_request from actors)) is null)::text;
reset role;

create or replace function pg_temp.is_open() returns boolean language plpgsql as $f$
declare v boolean; begin
  if to_regprocedure('public.fetch_is_open()') is null then return null; end if;
  execute 'select public.fetch_is_open()' into v; return v; end $f$;
grant execute on function pg_temp.is_open() to public;
-- ── what each actor can DO while paused ─────────────────────────────────────────────────────────────────────────────
create or replace function pg_temp.try(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  declare n int; begin execute p_sql; get diagnostics n = row_count; reset role; return 'ALLOWED, rows affected: ' || n;
  exception when others then reset role; return 'BLOCKED: ' || left(sqlerrm, 70); end;
end $f$;
grant execute on function pg_temp.try(text, uuid, text) to public;
insert into r select 'paused_flag', coalesce((not pg_temp.is_open())::text, 'no switch exists');
insert into r select 'customer_creates_request', pg_temp.try('authenticated', (select pending_owner from actors), format($q$insert into delivery_requests(customer_id, status) values (%L, 'pending')$q$, (select pending_owner from actors)));
insert into r select 'driver_accepts_pending_job', pg_temp.try('service_role', (select stranger_driver from actors), format($q$update delivery_requests set status = 'matched' where id = %L$q$, (select a_pending_request from actors)));
insert into r select 'client_edits_request_directly', pg_temp.try('authenticated', (select stranger_driver from actors), format($q$update delivery_requests set destination_address = 'x' where id = %L$q$, (select a_pending_request from actors)));
insert into r select 'driver_creates_run', pg_temp.try('authenticated', (select stranger_driver from actors), format($q$insert into runs(driver_id) values (%L)$q$, (select stranger_driver from actors)));
create temp table newid as select gen_random_uuid() u; grant select on newid to public;
insert into r select 'new_driver_application', pg_temp.try('authenticated', (select u from newid), format($q$insert into driver_profiles(id, driver_status) values (%L, 'pending')$q$, (select u from newid)));
insert into r select 'admin_approves_driver', pg_temp.try('authenticated', (select admin from actors), format($q$update driver_profiles set driver_status = 'approved' where id = %L$q$, (select pending_applicant from actors)));
insert into r select 'admin_rejects_driver_still_possible', pg_temp.try('authenticated', (select admin from actors), format($q$update driver_profiles set driver_status = 'rejected' where id = %L$q$, (select pending_applicant from actors)));
insert into r select 'server_can_still_cancel_existing_request', pg_temp.try('service_role', null, format($q$update delivery_requests set status = 'cancelled' where id = %L$q$, (select a_pending_request from actors)));

-- ── the switch really is a switch (inside this rolled-back transaction only) ───────────────────────────────────────────
update admin_config set value = 'open' where key = 'fetch.operations' and to_regprocedure('public.fetch_is_open()') is not null;
insert into r select 'switch_open_reports_open', coalesce(pg_temp.is_open()::text, 'n/a');
insert into r select 'driver_accepts_when_open', pg_temp.try('service_role', (select stranger_driver from actors), format($q$update delivery_requests set status = 'matched' where id = %L$q$, (select a_pending_request from actors)));
update admin_config set value = 'banana' where key = 'fetch.operations';
insert into r select 'garbage_value_stays_paused', coalesce((not pg_temp.is_open())::text, 'n/a');
delete from admin_config where key = 'fetch.operations';
insert into r select 'missing_row_stays_paused', coalesce((not pg_temp.is_open())::text, 'n/a');
select jsonb_object_agg(k, v) from r;
rollback;
