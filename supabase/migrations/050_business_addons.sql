-- 050_business_addons.sql
-- Business slugs + modular add-on feature flags

-- ── 1. Slug column on local_businesses ─────────────────────────────────────────

ALTER TABLE local_businesses ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_slug_idx ON local_businesses (slug);

-- Generate a URL-safe, unique slug from a business name.
-- Loops appending -1, -2, … until the candidate is free (excluding p_id if updating).
CREATE OR REPLACE FUNCTION generate_business_slug(p_name text, p_id uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix    int := 0;
BEGIN
  base_slug := lower(
    regexp_replace(
      regexp_replace(trim(p_name), '[^a-zA-Z0-9\s]', '', 'g'),
      '\s+', '-', 'g'
    )
  );
  base_slug := left(base_slug, 60);
  candidate := base_slug;
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM local_businesses
      WHERE slug = candidate AND (p_id IS NULL OR id != p_id)
    ) THEN
      RETURN candidate;
    END IF;
    suffix    := suffix + 1;
    candidate := base_slug || '-' || suffix;
  END LOOP;
END;
$$;

-- Backfill slugs for all existing businesses (row by row to avoid unique clashes).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, name FROM local_businesses WHERE slug IS NULL ORDER BY created_at LOOP
    UPDATE local_businesses SET slug = generate_business_slug(r.name, r.id) WHERE id = r.id;
  END LOOP;
END;
$$;

-- Auto-set slug on INSERT if the caller doesn't provide one.
CREATE OR REPLACE FUNCTION tg_set_business_slug()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := generate_business_slug(NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_local_businesses_slug ON local_businesses;
CREATE TRIGGER tg_local_businesses_slug
  BEFORE INSERT ON local_businesses
  FOR EACH ROW EXECUTE FUNCTION tg_set_business_slug();

-- ── 2. business_addons table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS business_addons (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES local_businesses(id) ON DELETE CASCADE,
  addon_key   text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT false,
  config      jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE(business_id, addon_key),
  CONSTRAINT valid_addon_key CHECK (
    addon_key IN (
      'products', 'bookings', 'services', 'events', 'membership',
      'offers', 'stamps', 'enquiries', 'payments', 'featured'
    )
  )
);

CREATE INDEX IF NOT EXISTS business_addons_business_id_idx ON business_addons (business_id);

-- ── 3. RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE business_addons ENABLE ROW LEVEL SECURITY;

-- Owner reads all their own add-ons (enabled or not — needed for the dashboard).
CREATE POLICY "business_addons_owner_select" ON business_addons
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM local_businesses lb
      WHERE lb.id = business_id AND lb.owner_id = auth.uid()
    )
  );

-- Anyone can read enabled add-ons on an active business (customer-facing profile).
CREATE POLICY "business_addons_public_select" ON business_addons
  FOR SELECT USING (
    enabled = true
    AND EXISTS (
      SELECT 1 FROM local_businesses lb
      WHERE lb.id = business_id AND lb.is_active = true
    )
  );

-- Owner can toggle their own add-ons; tier enforcement is done in the app layer.
CREATE POLICY "business_addons_owner_update" ON business_addons
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM local_businesses lb
      WHERE lb.id = business_id AND lb.owner_id = auth.uid()
    )
  );

-- Admins: full access.
CREATE POLICY "business_addons_admin_all" ON business_addons
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── 4. Trigger to seed add-on rows for every new business ─────────────────────

CREATE OR REPLACE FUNCTION tg_seed_business_addons()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO business_addons (business_id, addon_key, enabled) VALUES
    -- Standard add-ons: on by default for every plan
    (NEW.id, 'offers',     true),
    (NEW.id, 'stamps',     true),
    (NEW.id, 'enquiries',  true),
    (NEW.id, 'payments',   true),
    (NEW.id, 'featured',   true),
    -- Premium add-ons: off until Premium plan + owner enables
    (NEW.id, 'bookings',   false),
    (NEW.id, 'services',   false),
    (NEW.id, 'events',     false),
    (NEW.id, 'membership', false),
    (NEW.id, 'products',   false)
  ON CONFLICT (business_id, addon_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_seed_business_addons ON local_businesses;
CREATE TRIGGER tg_seed_business_addons
  AFTER INSERT ON local_businesses
  FOR EACH ROW EXECUTE FUNCTION tg_seed_business_addons();

-- ── 5. Backfill add-on rows for all existing businesses ────────────────────────

INSERT INTO business_addons (business_id, addon_key, enabled)
SELECT
  lb.id,
  a.addon_key,
  CASE
    WHEN a.addon_key = 'bookings'
      THEN (lb.accepts_bookings = true AND lb.subscription_tier = 'premium')
    WHEN a.addon_key IN ('offers', 'stamps', 'enquiries', 'payments', 'featured')
      THEN true
    ELSE false
  END
FROM local_businesses lb
CROSS JOIN (VALUES
  ('products'), ('bookings'), ('services'), ('events'), ('membership'),
  ('offers'), ('stamps'), ('enquiries'), ('payments'), ('featured')
) AS a(addon_key)
ON CONFLICT (business_id, addon_key) DO NOTHING;
