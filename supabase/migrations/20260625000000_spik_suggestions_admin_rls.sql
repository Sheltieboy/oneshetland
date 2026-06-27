-- Spik suggestions: let admins read + triage community suggestions.
--
-- BUG: public.spik_suggestions had RLS enabled with only an INSERT policy
-- ("anyone can submit"). With RLS on and no SELECT/UPDATE policy, those
-- operations default to DENY, so the admin review screen
-- (app/(admin)/spik-suggestions.tsx) returned zero rows — admins "couldn't see
-- the community suggestions to assess" — and Mark as reviewed/pending silently
-- did nothing. Add admin SELECT + UPDATE policies using the existing
-- SECURITY DEFINER is_admin() helper (same convention as the profiles policies).

DROP POLICY IF EXISTS "admins can read suggestions"   ON public.spik_suggestions;
DROP POLICY IF EXISTS "admins can update suggestions"  ON public.spik_suggestions;

CREATE POLICY "admins can read suggestions"
  ON public.spik_suggestions
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "admins can update suggestions"
  ON public.spik_suggestions
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
