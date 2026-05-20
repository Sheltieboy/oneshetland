-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: Allow approved drivers to read all pending requests
-- and update requests they accept.
--
-- Problem: the existing policy only lets drivers see requests matched to their
-- own runs. But the driver dashboard shows ALL pending requests so drivers can
-- choose which to accept. This migration adds the missing policies.
--
-- Run in Supabase: SQL Editor → New query → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Approved drivers can read all pending requests
--    (so they can see what's available to accept)
CREATE POLICY "Approved drivers can read all pending requests"
  ON public.delivery_requests FOR SELECT
  USING (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.driver_profiles dp
      WHERE dp.id = auth.uid()
        AND dp.driver_status = 'approved'
    )
  );

-- 2. Approved drivers can update requests to accept them
--    (set status = 'matched' and link their run_id)
CREATE POLICY "Approved drivers can accept pending requests"
  ON public.delivery_requests FOR UPDATE
  USING (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.driver_profiles dp
      WHERE dp.id = auth.uid()
        AND dp.driver_status = 'approved'
    )
  )
  WITH CHECK (
    status IN ('matched', 'collected', 'delivered')
  );

-- 3. Drivers can also update the status of requests on their own runs
--    (collected → delivered progression)
CREATE POLICY "Drivers can update status of their matched requests"
  ON public.delivery_requests FOR UPDATE
  USING (
    run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.runs r
      WHERE r.id = delivery_requests.run_id
        AND r.driver_id = auth.uid()
    )
  )
  WITH CHECK (
    status IN ('matched', 'collected', 'delivered', 'cancelled')
  );
