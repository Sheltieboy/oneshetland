-- Exact reversal of 20261212000000_fetch_safety_pause.sql. Restores the four policies as they were in production on 6 Nov 2026 (including the privacy exposure):
-- only run this deliberately.
begin;
drop trigger if exists delivery_requests_a_fetch_pause on public.delivery_requests;
drop trigger if exists runs_a_fetch_pause on public.runs;
drop trigger if exists driver_profiles_a_fetch_pause on public.driver_profiles;
drop function if exists public.tg_fetch_pause_requests();
drop function if exists public.tg_fetch_pause_runs();
drop function if exists public.tg_fetch_pause_drivers();
drop function if exists public.fetch_is_open();
delete from public.admin_config where key = 'fetch.operations';

create policy "Approved drivers can read all pending requests" on public.delivery_requests for select to public
  using ((status = 'pending'::text) and (exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved'::text)));
create policy "Approved drivers can read pending requests" on public.delivery_requests for select to public
  using ((status = 'pending'::text) and (exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved'::text)));
create policy "Approved drivers can accept pending requests" on public.delivery_requests for update to public
  using ((status = 'pending'::text) and (exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved'::text)))
  with check (status = any (array['matched'::text, 'collected'::text, 'delivered'::text]));
create policy "Drivers must have bank connected to accept requests" on public.delivery_requests for update to public
  using (exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.stripe_onboarding_complete = true and dp.stripe_payouts_enabled = true));
commit;
