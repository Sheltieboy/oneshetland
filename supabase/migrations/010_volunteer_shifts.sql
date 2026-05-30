-- Allow 'volunteer' as a pay_type so organisers can post unpaid/volunteer shifts.
-- Safely drops any existing pay_type check constraint first (name may vary or
-- may not exist if the table was created outside migrations).

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM   pg_constraint
  WHERE  conrelid = 'public.shifts'::regclass
    AND  contype  = 'c'
    AND  pg_get_constraintdef(oid) LIKE '%pay_type%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.shifts DROP CONSTRAINT ' || quote_ident(v_constraint);
  END IF;
END $$;

ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_pay_type_check
  CHECK (pay_type IN ('hourly', 'fixed', 'negotiable', 'discuss', 'volunteer'));
