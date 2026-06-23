-- ── Normalise spik_dictionary origin + usage_level casing ────────────────────
-- The stats grouping treats values case-sensitively, so "Unknown" with 3 rows
-- appears as a separate bucket from "unknown" with 265. Same drift can hit
-- usage_level. Two-part fix:
--
--   1. One-time UPDATE to lowercase + trim existing rows
--   2. BEFORE-trigger so any future insert/update lands normalised

-- ── 1. Clean existing data ──────────────────────────────────────────────────
UPDATE public.spik_dictionary
   SET origin = LOWER(TRIM(origin))
 WHERE origin IS NOT NULL
   AND origin <> LOWER(TRIM(origin));

UPDATE public.spik_dictionary
   SET usage_level = LOWER(TRIM(usage_level))
 WHERE usage_level IS NOT NULL
   AND usage_level <> LOWER(TRIM(usage_level));

-- ── 2. Trigger to keep them clean ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.spik_normalise_origin_usage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin IS NOT NULL THEN
    NEW.origin := LOWER(TRIM(NEW.origin));
  END IF;
  IF NEW.usage_level IS NOT NULL THEN
    NEW.usage_level := LOWER(TRIM(NEW.usage_level));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spik_normalise_origin_usage_trigger ON public.spik_dictionary;
CREATE TRIGGER spik_normalise_origin_usage_trigger
  BEFORE INSERT OR UPDATE ON public.spik_dictionary
  FOR EACH ROW
  EXECUTE FUNCTION public.spik_normalise_origin_usage();

COMMENT ON FUNCTION public.spik_normalise_origin_usage IS
  'Forces spik_dictionary.origin and usage_level to lower-cased, trimmed text so '
  'the Spik stats grouping doesn''t produce duplicate buckets like "Unknown" vs '
  '"unknown". Added 2026-05-29.';
