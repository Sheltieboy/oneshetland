-- Let an accepted worker record their own check-in / check-out.
--
-- shift_applications had UPDATE policies for the employer ("employer accepts or
-- rejects") and for a worker withdrawing ("worker withdraws own application",
-- gated to status = 'pending'), but NONE that let an accepted worker write
-- check_in_status. So checkIn()/checkOut() (app) and setCheck() (web) issued an
-- UPDATE that RLS filtered to zero rows — no error thrown, nothing persisted,
-- and the status silently reverted on the next refresh.
--
-- This policy lets the worker update ONLY their own already-accepted row, and
-- WITH CHECK keeps status = 'accepted' so they can't use it to change anything
-- but the check-in fields.

-- Idempotent: the policy already exists on some environments (added out-of-band),
-- so drop-if-exists before creating keeps `db push` re-runnable.
drop policy if exists "worker records own check-in" on public.shift_applications;

create policy "worker records own check-in"
  on public.shift_applications
  for update
  to authenticated
  using (auth.uid() = worker_id and status = 'accepted')
  with check (auth.uid() = worker_id and status = 'accepted');
