-- ============================================================================
-- OneShetland — Jobs board install (idempotent, self-contained)
-- ----------------------------------------------------------------------------
-- This database never had the Jobs board applied (base `jobs` table from
-- migration 045, then the 078 additions). This script installs both in one go.
-- Safe to run on a live DB and safe to run more than once (IF NOT EXISTS /
-- CREATE OR REPLACE / DROP … IF EXISTS throughout). Depends only on `profiles`
-- and `local_businesses`, which already exist.
--
-- RUN: paste into Supabase → SQL editor → Run.  Then re-run scripts/seed-demo.sql
-- to populate the demo jobs.
-- ============================================================================

-- ── 1. Base jobs table (from migration 045) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  posted_as_business_id UUID REFERENCES public.local_businesses(id) ON DELETE SET NULL,
  title           TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description     TEXT,
  category        TEXT,
  location        TEXT,
  locality        TEXT,
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),
  contract_type   TEXT NOT NULL DEFAULT 'full-time'
                    CHECK (contract_type IN ('full-time','part-time','casual','apprenticeship','volunteer','freelance')),
  pay_text        TEXT,
  apply_url       TEXT,
  apply_email     TEXT,
  is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_posted    ON public.jobs(posted_at DESC) WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_jobs_locality  ON public.jobs(locality)       WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_jobs_featured  ON public.jobs(is_featured)    WHERE is_featured AND NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_jobs_employer  ON public.jobs(employer_id);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jobs read"   ON public.jobs;
DROP POLICY IF EXISTS "jobs insert" ON public.jobs;
DROP POLICY IF EXISTS "jobs update" ON public.jobs;
DROP POLICY IF EXISTS "jobs delete" ON public.jobs;

CREATE POLICY "jobs read" ON public.jobs FOR SELECT USING (
  NOT is_hidden AND (expires_at IS NULL OR expires_at > NOW())
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
);
CREATE POLICY "jobs insert" ON public.jobs FOR INSERT WITH CHECK (
  auth.uid() IS NOT NULL AND employer_id = auth.uid()
);
CREATE POLICY "jobs update" ON public.jobs FOR UPDATE USING (
  employer_id = auth.uid()
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
);
CREATE POLICY "jobs delete" ON public.jobs FOR DELETE USING (
  employer_id = auth.uid()
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

-- ── 2. Jobs board extensions (from migration 078) ───────────────────────────
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS pay_min            numeric(10,2),
  ADD COLUMN IF NOT EXISTS pay_max            numeric(10,2),
  ADD COLUMN IF NOT EXISTS pay_period         text CHECK (pay_period IN ('hour','day','week','month','year','total')),
  ADD COLUMN IF NOT EXISTS pay_hidden         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS boosted_until      timestamptz,
  ADD COLUMN IF NOT EXISTS relocation_support boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS housing_available  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_seasonal        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS season_label       text,
  ADD COLUMN IF NOT EXISTS remote_mode        text NOT NULL DEFAULT 'on_site' CHECK (remote_mode IN ('on_site','hybrid','remote')),
  ADD COLUMN IF NOT EXISTS views_count        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS application_count  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','filled')),
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.tg_jobs_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN new.updated_at := now(); RETURN new; END; $$;
DROP TRIGGER IF EXISTS tg_jobs_touch ON public.jobs;
CREATE TRIGGER tg_jobs_touch BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_touch();

-- Job applications
CREATE TABLE IF NOT EXISTS public.job_applications (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs(id) on delete cascade,
  applicant_id     uuid not null references public.profiles(id) on delete cascade,
  status           text not null default 'applied'
                     check (status in ('applied','viewed','shortlisted','interview','offer','hired','declined','withdrawn')),
  cover_letter     text,
  profile_snapshot jsonb not null default '{}'::jsonb,
  visibility       text not null default 'full' check (visibility in ('full','snapshot')),
  employer_note    text,
  applied_at       timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_id, applicant_id)
);
CREATE INDEX IF NOT EXISTS idx_job_apps_job       ON public.job_applications(job_id, status);
CREATE INDEX IF NOT EXISTS idx_job_apps_applicant ON public.job_applications(applicant_id);
ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "job_applications applicant"      ON public.job_applications;
DROP POLICY IF EXISTS "job_applications employer read"  ON public.job_applications;
DROP POLICY IF EXISTS "job_applications employer update" ON public.job_applications;
DROP POLICY IF EXISTS "job_applications admin"          ON public.job_applications;
CREATE POLICY "job_applications applicant" ON public.job_applications
  FOR ALL USING (applicant_id = auth.uid()) WITH CHECK (applicant_id = auth.uid());
CREATE POLICY "job_applications employer read" ON public.job_applications
  FOR SELECT USING (exists (select 1 from public.jobs j where j.id = job_id and j.employer_id = auth.uid()));
CREATE POLICY "job_applications employer update" ON public.job_applications
  FOR UPDATE USING (exists (select 1 from public.jobs j where j.id = job_id and j.employer_id = auth.uid()));
CREATE POLICY "job_applications admin" ON public.job_applications
  FOR ALL USING (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator')));

CREATE OR REPLACE FUNCTION public.tg_job_application_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  new.updated_at := now();
  IF tg_op = 'UPDATE' AND new.status IS DISTINCT FROM old.status THEN new.status_changed_at := now(); END IF;
  RETURN new;
END; $$;
DROP TRIGGER IF EXISTS tg_job_application_touch ON public.job_applications;
CREATE TRIGGER tg_job_application_touch BEFORE INSERT OR UPDATE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.tg_job_application_touch();

CREATE OR REPLACE FUNCTION public.tg_job_application_count() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    UPDATE public.jobs SET application_count = application_count + 1 WHERE id = new.job_id;
  ELSIF tg_op = 'DELETE' THEN
    UPDATE public.jobs SET application_count = greatest(application_count - 1, 0) WHERE id = old.job_id;
  END IF;
  RETURN null;
END; $$;
DROP TRIGGER IF EXISTS tg_job_application_count ON public.job_applications;
CREATE TRIGGER tg_job_application_count AFTER INSERT OR DELETE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.tg_job_application_count();

-- Application pipeline history
CREATE TABLE IF NOT EXISTS public.application_events (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_applications(id) on delete cascade,
  from_status    text,
  to_status      text not null,
  actor_id       uuid references public.profiles(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS idx_application_events_app ON public.application_events(application_id, created_at);
ALTER TABLE public.application_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "application_events read" ON public.application_events;
CREATE POLICY "application_events read" ON public.application_events FOR SELECT USING (
  exists (
    select 1 from public.job_applications ja join public.jobs j on j.id = ja.job_id
    where ja.id = application_id and (ja.applicant_id = auth.uid() or j.employer_id = auth.uid())
  )
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator'))
);
CREATE OR REPLACE FUNCTION public.tg_application_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    INSERT INTO public.application_events (application_id, from_status, to_status, actor_id)
    VALUES (new.id, null, new.status, new.applicant_id);
  ELSIF tg_op = 'UPDATE' AND new.status IS DISTINCT FROM old.status THEN
    INSERT INTO public.application_events (application_id, from_status, to_status, actor_id)
    VALUES (new.id, old.status, new.status, auth.uid());
  END IF;
  RETURN null;
END; $$;
DROP TRIGGER IF EXISTS tg_application_event ON public.job_applications;
CREATE TRIGGER tg_application_event AFTER INSERT OR UPDATE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.tg_application_event();

-- Shared worker (candidate) profile
CREATE TABLE IF NOT EXISTS public.worker_profiles (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  headline            text,
  summary             text,
  skills              text[] not null default '{}',
  qualifications      text[] not null default '{}',
  experience          jsonb  not null default '[]'::jsonb,
  desired_pay_text    text,
  willing_to_relocate boolean not null default false,
  available_from      date,
  is_diaspora         boolean not null default false,
  is_public           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
ALTER TABLE public.worker_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "worker_profiles owner"        ON public.worker_profiles;
DROP POLICY IF EXISTS "worker_profiles employer read" ON public.worker_profiles;
CREATE POLICY "worker_profiles owner" ON public.worker_profiles
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "worker_profiles employer read" ON public.worker_profiles FOR SELECT USING (
  exists (
    select 1 from public.job_applications ja join public.jobs j on j.id = ja.job_id
    where ja.applicant_id = worker_profiles.user_id and j.employer_id = auth.uid()
  )
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator'))
);
CREATE OR REPLACE FUNCTION public.tg_worker_profile_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN new.updated_at := now(); RETURN new; END; $$;
DROP TRIGGER IF EXISTS tg_worker_profile_touch ON public.worker_profiles;
CREATE TRIGGER tg_worker_profile_touch BEFORE UPDATE ON public.worker_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_worker_profile_touch();

-- CV / cover-letter library
CREATE TABLE IF NOT EXISTS public.cv_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  kind            text not null check (kind in ('cv','cover_letter')),
  label           text not null,
  body            text,
  external_url    text,
  is_primary      boolean not null default false,
  generated_by_ai boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS idx_cv_documents_user ON public.cv_documents(user_id, kind);
ALTER TABLE public.cv_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cv_documents owner" ON public.cv_documents;
CREATE POLICY "cv_documents owner" ON public.cv_documents
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Saved jobs
CREATE TABLE IF NOT EXISTS public.saved_jobs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  job_id     uuid not null references public.jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, job_id)
);
ALTER TABLE public.saved_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "saved_jobs owner" ON public.saved_jobs;
CREATE POLICY "saved_jobs owner" ON public.saved_jobs
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Free 'jobs' business add-on key + backfill
ALTER TABLE public.business_addons DROP CONSTRAINT IF EXISTS valid_addon_key;
ALTER TABLE public.business_addons ADD CONSTRAINT valid_addon_key CHECK (
  addon_key IN ('products','bookings','services','events','membership','offers','stamps','enquiries','payments','featured','jobs')
);
INSERT INTO public.business_addons (business_id, addon_key, enabled)
SELECT id, 'jobs', false FROM public.local_businesses
ON CONFLICT (business_id, addon_key) DO NOTHING;

-- GDPR purge helper (call on a schedule)
CREATE OR REPLACE FUNCTION public.purge_old_job_applications() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted int;
BEGIN
  WITH gone AS (
    DELETE FROM public.job_applications
    WHERE status IN ('declined','withdrawn') AND status_changed_at < now() - interval '6 months'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM gone;
  RETURN v_deleted;
END; $$;
REVOKE ALL ON FUNCTION public.purge_old_job_applications() FROM public;
