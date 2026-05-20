-- OneShetland Delivers — Seed Data
-- Run AFTER 001_initial_schema.sql.
-- Supabase dashboard: SQL Editor → New query → paste → Run.

-- ─────────────────────────────────────────────
-- REGIONS
-- ─────────────────────────────────────────────
INSERT INTO public.regions (slug, name, display_order) VALUES
  ('lerwick',          'Lerwick',                  1),
  ('scalloway',        'Scalloway',                2),
  ('central-mainland', 'Central Mainland',         3),
  ('south-mainland',   'South Mainland',           4),
  ('west-mainland',    'West Mainland',            5),
  ('north-mainland',   'North Mainland',           6),
  ('northmavine',      'Northmavine',              7),
  ('bressay',          'Bressay',                  8),
  ('burra',            'Burra',                    9),
  ('trondra',          'Trondra',                 10),
  ('muckle-roe',       'Muckle Roe',              11),
  ('whalsay',          'Whalsay',                 12),
  ('yell',             'Yell',                    13),
  ('unst',             'Unst',                    14),
  ('fetlar',           'Fetlar',                  15),
  ('out-skerries',     'Out Skerries',            16),
  ('fair-isle',        'Fair Isle',               17)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, display_order = EXCLUDED.display_order;

-- ─────────────────────────────────────────────
-- DELIVERY CATEGORIES
-- ─────────────────────────────────────────────
INSERT INTO public.delivery_categories (slug, name, icon) VALUES
  ('takeaway',                  'Takeaway',                      '🍕'),
  ('pharmacy',                  'Pharmacy collection',           '💊'),
  ('small-parcel',              'Small parcel',                  '📦'),
  ('shop-collection',           'Shop collection',               '🛍️'),
  ('supermarket-click-collect', 'Supermarket click-and-collect', '🛒'),
  ('other',                     'Other small collection',        '📫')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon;
