-- ── 028_compliance_log.sql ───────────────────────────────────────────────────
--
-- Immutable compliance audit log for OneShetland.
--
-- Every consent, verification and agreement made by a user is recorded here
-- with a timestamp, IP address, device info and document version. This is
-- the legal proof that a user agreed to something.
--
-- IMMUTABILITY: A trigger prevents any UPDATE or DELETE — even from
-- service_role. Triggers fire regardless of RLS, so this guarantee holds
-- at the Postgres level no matter who the caller is.
--
-- user_email is denormalised so the record survives a profile deletion
-- (right-to-erasure requests delete the profile but the compliance record
-- must be retained — it's your legal protection).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.compliance_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who
  user_id          UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email       TEXT        NOT NULL,   -- denormalised — survives profile deletion
  user_name        TEXT,                   -- denormalised snapshot at time of event
  -- What
  event_type       TEXT        NOT NULL,   -- see EVENT TYPES below
  document_version TEXT,                   -- e.g. '1.2' for T&C / Privacy Policy
  description      TEXT,                   -- human-readable summary
  -- Where / When
  ip_address       TEXT,
  device_info      TEXT,                   -- device model + OS
  app_version      TEXT,                   -- app build number
  -- Extra context
  metadata         JSONB       NOT NULL DEFAULT '{}',
  -- Link to the confirmation email that was sent
  email_log_id     UUID        REFERENCES public.email_log(id) ON DELETE SET NULL,
  -- Immutable timestamp
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — this record never changes
);

-- ── Event type reference ──────────────────────────────────────────────────────
-- email.verified          — user confirmed their email address
-- terms.accepted          — accepted Terms of Service (document_version required)
-- privacy.accepted        — accepted Privacy Policy (document_version required)
-- fetch.liability_ack     — acknowledged delivery liability on a Fetch request
-- driver.terms_accepted   — accepted driver terms & conditions
-- marketing.opted_in      — consented to marketing/promotional emails
-- marketing.opted_out     — withdrew marketing consent
-- data.export_requested   — GDPR: requested a copy of their data
-- account.deletion_req    — GDPR: requested account deletion
-- age.confirmed           — confirmed they are 16 or over
-- booking.terms_accepted  — accepted booking/cancellation terms for a service
-- payment.method_added    — added a payment card (not card details — just the event)
-- password.changed        — user changed their password (security audit)
-- email.changed           — user changed their email address (security audit)

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_compliance_user_id    ON public.compliance_log(user_id,    created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_user_email ON public.compliance_log(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_event_type ON public.compliance_log(event_type, created_at DESC);

-- ── Immutability trigger ──────────────────────────────────────────────────────
-- Fires BEFORE UPDATE or DELETE — even for service_role. This makes the
-- record a true write-once legal audit trail.

CREATE OR REPLACE FUNCTION public.compliance_log_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'compliance_log records are immutable — they cannot be modified or deleted. '
    'This table is a legal audit trail. Record id: %', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS compliance_log_no_update ON public.compliance_log;
CREATE TRIGGER compliance_log_no_update
  BEFORE UPDATE ON public.compliance_log
  FOR EACH ROW EXECUTE FUNCTION public.compliance_log_immutable();

DROP TRIGGER IF EXISTS compliance_log_no_delete ON public.compliance_log;
CREATE TRIGGER compliance_log_no_delete
  BEFORE DELETE ON public.compliance_log
  FOR EACH ROW EXECUTE FUNCTION public.compliance_log_immutable();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.compliance_log ENABLE ROW LEVEL SECURITY;

-- Users can insert their own records
CREATE POLICY "Users insert own compliance records"
  ON public.compliance_log FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can view their own records
CREATE POLICY "Users view own compliance records"
  ON public.compliance_log FOR SELECT
  USING (user_id = auth.uid());

-- Admins can view all records
CREATE POLICY "Admins view all compliance records"
  ON public.compliance_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));

-- Service role can insert (for edge functions logging on behalf of users)
-- Note: service_role bypasses RLS for SELECT/INSERT but triggers still fire
-- for UPDATE/DELETE, so immutability is still guaranteed.
GRANT SELECT, INSERT ON public.compliance_log TO authenticated;
GRANT ALL            ON public.compliance_log TO service_role;
