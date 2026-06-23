-- NFC tile support for local businesses.
-- Each verified Pro/Premium business gets a branded NFC tile encoded with
-- https://oneshetland.com/t/{nfc_token}. Tapping the tile opens the app,
-- which captures the user's GPS and calls local-nfc-stamp to verify proximity
-- before adding a stamp.

ALTER TABLE public.local_businesses
  ADD COLUMN IF NOT EXISTS nfc_token         TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS nfc_status        TEXT NOT NULL DEFAULT 'none'
    CHECK (nfc_status IN ('none', 'requested', 'dispatched', 'active')),
  ADD COLUMN IF NOT EXISTS nfc_dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nfc_activated_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_local_businesses_nfc_token
  ON public.local_businesses(nfc_token)
  WHERE nfc_token IS NOT NULL;

-- Generates a short, readable unique token like "gh-3f7a9c2d"
CREATE OR REPLACE FUNCTION public.generate_nfc_token(business_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_slug TEXT;
  v_token TEXT;
  v_exists INT;
  v_attempts INT := 0;
BEGIN
  -- 2-3 char slug from business name
  v_slug := lower(regexp_replace(substring(business_name, 1, 2), '[^a-z0-9]', '', 'gi'));
  IF length(v_slug) < 2 THEN v_slug := 'lo'; END IF;

  LOOP
    v_token := v_slug || '-' || lower(substring(md5(random()::text || clock_timestamp()::text), 1, 8));
    SELECT count(*) INTO v_exists FROM public.local_businesses WHERE nfc_token = v_token;
    EXIT WHEN v_exists = 0;
    v_attempts := v_attempts + 1;
    IF v_attempts > 5 THEN
      v_token := v_slug || '-' || lower(substring(md5(random()::text || gen_random_uuid()::text), 1, 10));
      EXIT;
    END IF;
  END LOOP;

  RETURN v_token;
END $$;
