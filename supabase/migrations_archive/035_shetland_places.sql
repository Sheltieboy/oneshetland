-- ── 035_shetland_places.sql ─────────────────────────────────────────────────
--
-- Seed dataset for the "Map It" game — drop-a-pin distance-scored game.
--
-- Coverage: ~200 places across all of Shetland.
--   - Settlements (towns, villages, hamlets, crofting townships)
--   - Islands (inhabited and uninhabited)
--   - Voes (sea inlets) — the lifeblood of the geography
--   - Lochs (freshwater, scattered)
--   - Beaches (the sandy or shingled spots locals know)
--   - Headlands & cliffs (Hermaness, Esha Ness, Sumburgh Head etc.)
--   - Hills (Ronas Hill etc.)
--   - Lighthouses
--   - Brochs & ancient sites
--   - Sounds (water between islands)
--   - Notable landmarks
--
-- DIFFICULTY tiers:
--   easy   — recognised by anyone who's heard of Shetland (Lerwick, Sumburgh, Yell…)
--   medium — locals know, visitors might have heard (Vidlin, Cullivoe, Mavis Grind…)
--   hard   — requires real local knowledge (Bordastubble, Snolda, Hellisgill…)
--
-- IMPORTANT: lat/lng values are BEST-EFFORT from general geography.
--   - Major settlements/lighthouses: confident within ~300m
--   - Smaller villages / known landmarks: within ~1–2km
--   - Obscure crofts / geos / minor lochs: within ~2–3km, sometimes more
-- Verify against OS / OpenStreetMap before going live. A `notes` column is
-- provided to record verification status / source.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.game_shetland_places (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  alt_names    TEXT[],   -- common variants e.g. {"Esha Ness","Eshaness"}
  category     TEXT NOT NULL CHECK (category IN (
    'settlement','island','voe','loch','beach','headland','hill',
    'lighthouse','broch','sound','geo','landmark'
  )),
  difficulty   TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  lat          DECIMAL(9,6) NOT NULL,
  lng          DECIMAL(9,6) NOT NULL,
  region       TEXT,     -- 'south mainland','central','north mainland','yell','unst','fetlar','whalsay','bressay','foula','fair isle','out skerries','papa stour'
  notes        TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_shetland_places_difficulty
  ON public.game_shetland_places(difficulty) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_game_shetland_places_region
  ON public.game_shetland_places(region) WHERE is_active = TRUE;

ALTER TABLE public.game_shetland_places ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authed can read active places"
  ON public.game_shetland_places FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "Admins manage places"
  ON public.game_shetland_places FOR ALL
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin')
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- ── Seed: EASY tier (~45 places) ────────────────────────────────────────────
-- The places anyone who's looked at a Shetland map will recognise instantly.

INSERT INTO public.game_shetland_places (name, alt_names, category, difficulty, lat, lng, region) VALUES
  -- Major towns
  ('Lerwick',          NULL,                                'settlement', 'easy', 60.155,  -1.145, 'central'),
  ('Scalloway',        NULL,                                'settlement', 'easy', 60.135,  -1.275, 'central'),
  ('Brae',             NULL,                                'settlement', 'easy', 60.400,  -1.340, 'north mainland'),
  ('Sumburgh',         NULL,                                'settlement', 'easy', 59.873,  -1.291, 'south mainland'),
  ('Voe',              NULL,                                'settlement', 'easy', 60.358,  -1.275, 'north mainland'),
  ('Aith',             NULL,                                'settlement', 'easy', 60.288,  -1.355, 'central'),
  ('Walls',            NULL,                                'settlement', 'easy', 60.230,  -1.572, 'west mainland'),
  ('Bigton',           NULL,                                'settlement', 'easy', 59.973,  -1.337, 'south mainland'),
  ('Sandwick',         NULL,                                'settlement', 'easy', 60.001,  -1.245, 'south mainland'),
  ('Hillswick',        NULL,                                'settlement', 'easy', 60.479,  -1.484, 'north mainland'),
  ('Cunningsburgh',    NULL,                                'settlement', 'easy', 60.038,  -1.225, 'south mainland'),
  ('Mossbank',         NULL,                                'settlement', 'easy', 60.470,  -1.198, 'north mainland'),

  -- Islands
  ('Yell',             NULL,                                'island',     'easy', 60.620,  -1.090, 'yell'),
  ('Unst',             NULL,                                'island',     'easy', 60.755,  -0.880, 'unst'),
  ('Fetlar',           NULL,                                'island',     'easy', 60.620,  -0.850, 'fetlar'),
  ('Whalsay',          NULL,                                'island',     'easy', 60.345,  -0.965, 'whalsay'),
  ('Bressay',          NULL,                                'island',     'easy', 60.135,  -1.087, 'bressay'),
  ('Fair Isle',        NULL,                                'island',     'easy', 59.533,  -1.625, 'fair isle'),
  ('Foula',            NULL,                                'island',     'easy', 60.130,  -2.070, 'foula'),
  ('Papa Stour',       NULL,                                'island',     'easy', 60.328,  -1.690, 'west mainland'),
  ('Mousa',            NULL,                                'island',     'easy', 60.000,  -1.180, 'south mainland'),
  ('Burra',            ARRAY['West Burra','East Burra'],    'island',     'easy', 60.084,  -1.345, 'central'),
  ('Trondra',          NULL,                                'island',     'easy', 60.122,  -1.308, 'central'),

  -- Voes & sounds
  ('Sullom Voe',       NULL,                                'voe',        'easy', 60.450,  -1.270, 'north mainland'),
  ('Yell Sound',       NULL,                                'sound',      'easy', 60.500,  -1.150, 'north mainland'),
  ('Bluemull Sound',   NULL,                                'sound',      'easy', 60.690,  -0.985, 'unst'),
  ('Mousa Sound',      NULL,                                'sound',      'easy', 60.000,  -1.215, 'south mainland'),
  ('St Magnus Bay',    NULL,                                'voe',        'easy', 60.450,  -1.580, 'north mainland'),

  -- Headlands & landmarks
  ('Sumburgh Head',    NULL,                                'headland',   'easy', 59.852,  -1.273, 'south mainland'),
  ('Esha Ness',        ARRAY['Eshaness'],                   'headland',   'easy', 60.490,  -1.625, 'north mainland'),
  ('Hermaness',        NULL,                                'headland',   'easy', 60.830,  -0.920, 'unst'),
  ('Muckle Flugga',    NULL,                                'lighthouse', 'easy', 60.840,  -0.880, 'unst'),
  ('Mavis Grind',      NULL,                                'landmark',   'easy', 60.402,  -1.405, 'north mainland'),
  ('Ronas Hill',       NULL,                                'hill',       'easy', 60.535,  -1.412, 'north mainland'),
  ('Saxa Vord',        NULL,                                'hill',       'easy', 60.825,  -0.838, 'unst'),

  -- Ancient sites
  ('Jarlshof',         NULL,                                'broch',      'easy', 59.872,  -1.292, 'south mainland'),
  ('Mousa Broch',      NULL,                                'broch',      'easy', 60.001,  -1.182, 'south mainland'),
  ('Clickimin Broch',  NULL,                                'broch',      'easy', 60.149,  -1.157, 'central'),
  ('Scalloway Castle', NULL,                                'landmark',   'easy', 60.135,  -1.273, 'central'),

  -- Beaches & natural
  ('St Ninian''s Isle',ARRAY['St Ninian Isle','St Ninian''s'],'island',   'easy', 59.967,  -1.350, 'south mainland'),
  ('Quendale Beach',   NULL,                                'beach',      'easy', 59.910,  -1.355, 'south mainland'),

  -- Airports / key infrastructure
  ('Sumburgh Airport', NULL,                                'landmark',   'easy', 59.879,  -1.295, 'south mainland'),
  ('Tingwall Airport', NULL,                                'landmark',   'easy', 60.193,  -1.243, 'central'),
  ('Sullom Voe Terminal', NULL,                             'landmark',   'easy', 60.452,  -1.290, 'north mainland'),
  ('Lerwick Harbour',  NULL,                                'landmark',   'easy', 60.152,  -1.139, 'central');

-- ── Seed: MEDIUM tier (~85 places) ──────────────────────────────────────────
-- Local-grade names. Visitors who've spent a week here would mostly know these.

INSERT INTO public.game_shetland_places (name, alt_names, category, difficulty, lat, lng, region) VALUES
  -- South Mainland villages
  ('Boddam',           NULL,                                'settlement', 'medium', 59.910,  -1.298, 'south mainland'),
  ('Scousburgh',       NULL,                                'settlement', 'medium', 59.940,  -1.327, 'south mainland'),
  ('Dunrossness',      NULL,                                'settlement', 'medium', 59.911,  -1.297, 'south mainland'),
  ('Levenwick',        NULL,                                'settlement', 'medium', 59.980,  -1.245, 'south mainland'),
  ('Hoswick',          NULL,                                'settlement', 'medium', 60.000,  -1.219, 'south mainland'),
  ('Channerwick',      NULL,                                'settlement', 'medium', 60.013,  -1.220, 'south mainland'),
  ('Toab',             NULL,                                'settlement', 'medium', 59.880,  -1.300, 'south mainland'),
  ('Virkie',           NULL,                                'settlement', 'medium', 59.882,  -1.291, 'south mainland'),
  ('Grutness',         NULL,                                'settlement', 'medium', 59.868,  -1.290, 'south mainland'),
  ('Quarff',           NULL,                                'settlement', 'medium', 60.082,  -1.222, 'south mainland'),
  ('Gulberwick',       NULL,                                'settlement', 'medium', 60.110,  -1.180, 'south mainland'),
  ('Maywick',          NULL,                                'settlement', 'medium', 59.961,  -1.345, 'south mainland'),
  ('Skelberry',        NULL,                                'settlement', 'medium', 59.911,  -1.358, 'south mainland'),

  -- Central / West Mainland villages
  ('Tingwall',         NULL,                                'settlement', 'medium', 60.196,  -1.238, 'central'),
  ('Whiteness',        NULL,                                'settlement', 'medium', 60.197,  -1.300, 'central'),
  ('Weisdale',         NULL,                                'settlement', 'medium', 60.220,  -1.325, 'central'),
  ('Bixter',           NULL,                                'settlement', 'medium', 60.232,  -1.430, 'west mainland'),
  ('Twatt',            NULL,                                'settlement', 'medium', 60.245,  -1.430, 'west mainland'),
  ('Tresta',           NULL,                                'settlement', 'medium', 60.252,  -1.443, 'west mainland'),
  ('Bridge of Walls',  NULL,                                'settlement', 'medium', 60.230,  -1.555, 'west mainland'),
  ('Sandness',         NULL,                                'settlement', 'medium', 60.295,  -1.625, 'west mainland'),
  ('Skeld',            NULL,                                'settlement', 'medium', 60.158,  -1.452, 'west mainland'),
  ('Sandsound',        NULL,                                'settlement', 'medium', 60.205,  -1.430, 'west mainland'),
  ('Veensgarth',       NULL,                                'settlement', 'medium', 60.195,  -1.220, 'central'),
  ('Girlsta',          NULL,                                'settlement', 'medium', 60.215,  -1.195, 'central'),

  -- North Mainland villages
  ('Ollaberry',        NULL,                                'settlement', 'medium', 60.532,  -1.355, 'north mainland'),
  ('North Roe',        NULL,                                'settlement', 'medium', 60.580,  -1.350, 'north mainland'),
  ('Sullom',           NULL,                                'settlement', 'medium', 60.443,  -1.318, 'north mainland'),
  ('Toft',             NULL,                                'settlement', 'medium', 60.467,  -1.205, 'north mainland'),
  ('Laxo',             NULL,                                'settlement', 'medium', 60.382,  -1.180, 'north mainland'),
  ('Vidlin',           NULL,                                'settlement', 'medium', 60.385,  -1.110, 'north mainland'),
  ('Lunna',            NULL,                                'settlement', 'medium', 60.432,  -1.110, 'north mainland'),
  ('Heylor',           NULL,                                'settlement', 'medium', 60.490,  -1.483, 'north mainland'),
  ('Hamarsness',       NULL,                                'settlement', 'medium', 60.405,  -1.310, 'north mainland'),

  -- Yell villages
  ('Mid Yell',         NULL,                                'settlement', 'medium', 60.610,  -1.045, 'yell'),
  ('Burravoe',         ARRAY['Burra Voe'],                  'settlement', 'medium', 60.500,  -1.030, 'yell'),
  ('Ulsta',            NULL,                                'settlement', 'medium', 60.495,  -1.155, 'yell'),
  ('Gutcher',          NULL,                                'settlement', 'medium', 60.692,  -0.987, 'yell'),
  ('Cullivoe',         NULL,                                'settlement', 'medium', 60.695,  -0.992, 'yell'),
  ('Sellafirth',       NULL,                                'settlement', 'medium', 60.670,  -0.995, 'yell'),
  ('Aywick',           NULL,                                'settlement', 'medium', 60.622,  -1.012, 'yell'),
  ('Otterswick',       NULL,                                'settlement', 'medium', 60.617,  -1.010, 'yell'),
  ('Gloup',            NULL,                                'settlement', 'medium', 60.733,  -1.013, 'yell'),
  ('West Sandwick',    NULL,                                'settlement', 'medium', 60.580,  -1.150, 'yell'),

  -- Unst villages
  ('Baltasound',       NULL,                                'settlement', 'medium', 60.752,  -0.860, 'unst'),
  ('Haroldswick',      NULL,                                'settlement', 'medium', 60.775,  -0.840, 'unst'),
  ('Uyeasound',        NULL,                                'settlement', 'medium', 60.705,  -0.955, 'unst'),
  ('Belmont',          NULL,                                'settlement', 'medium', 60.695,  -0.965, 'unst'),
  ('Norwick',          NULL,                                'settlement', 'medium', 60.815,  -0.785, 'unst'),

  -- Fetlar villages
  ('Houbie',           NULL,                                'settlement', 'medium', 60.617,  -0.825, 'fetlar'),
  ('Tresta',           ARRAY['Tresta (Fetlar)'],            'settlement', 'medium', 60.610,  -0.855, 'fetlar'),
  ('Funzie',           NULL,                                'settlement', 'medium', 60.622,  -0.770, 'fetlar'),

  -- Whalsay & Out Skerries
  ('Symbister',        NULL,                                'settlement', 'medium', 60.350,  -1.000, 'whalsay'),
  ('Skaw',             ARRAY['Skaw (Whalsay)'],             'settlement', 'medium', 60.380,  -0.937, 'whalsay'),
  ('Bruray',           NULL,                                'island',     'medium', 60.422,  -0.747, 'out skerries'),
  ('Housay',           NULL,                                'island',     'medium', 60.420,  -0.745, 'out skerries'),

  -- Voes
  ('Aith Voe',         NULL,                                'voe',        'medium', 60.290,  -1.360, 'central'),
  ('Weisdale Voe',     NULL,                                'voe',        'medium', 60.230,  -1.330, 'central'),
  ('Whiteness Voe',    NULL,                                'voe',        'medium', 60.200,  -1.302, 'central'),
  ('Olnafirth',        NULL,                                'voe',        'medium', 60.360,  -1.275, 'north mainland'),
  ('Colla Firth',      NULL,                                'voe',        'medium', 60.523,  -1.197, 'north mainland'),
  ('Dales Voe',        NULL,                                'voe',        'medium', 60.187,  -1.140, 'central'),
  ('Garths Voe',       NULL,                                'voe',        'medium', 60.455,  -1.280, 'north mainland'),
  ('Wadbister Voe',    NULL,                                'voe',        'medium', 60.215,  -1.130, 'central'),
  ('Gluss Voe',        NULL,                                'voe',        'medium', 60.498,  -1.355, 'north mainland'),

  -- Lochs
  ('Loch of Tingwall', NULL,                                'loch',       'medium', 60.198,  -1.240, 'central'),
  ('Loch of Spiggie',  NULL,                                'loch',       'medium', 59.937,  -1.342, 'south mainland'),
  ('Loch of Strom',    NULL,                                'loch',       'medium', 60.180,  -1.300, 'central'),
  ('Loch of Cliff',    NULL,                                'loch',       'medium', 60.788,  -0.870, 'unst'),
  ('Sandy Loch',       NULL,                                'loch',       'medium', 60.145,  -1.165, 'central'),
  ('Loch of Brindister',NULL,                               'loch',       'medium', 60.115,  -1.195, 'central'),

  -- Beaches
  ('Meal Beach',       NULL,                                'beach',      'medium', 60.103,  -1.378, 'central'),
  ('Spiggie Beach',    NULL,                                'beach',      'medium', 59.937,  -1.345, 'south mainland'),
  ('Norwick Beach',    NULL,                                'beach',      'medium', 60.815,  -0.778, 'unst'),
  ('Skaw Beach',       ARRAY['Skaw Beach (Unst)'],          'beach',      'medium', 60.832,  -0.787, 'unst'),
  ('Levenwick Beach',  NULL,                                'beach',      'medium', 59.985,  -1.241, 'south mainland'),
  ('Banna Minn',       NULL,                                'beach',      'medium', 60.092,  -1.388, 'central'),

  -- Lighthouses
  ('Bressay Lighthouse',NULL,                               'lighthouse', 'medium', 60.122,  -1.075, 'bressay'),
  ('Esha Ness Lighthouse',NULL,                             'lighthouse', 'medium', 60.488,  -1.625, 'north mainland'),
  ('Fair Isle South Lighthouse',NULL,                       'lighthouse', 'medium', 59.510,  -1.640, 'fair isle'),
  ('Fair Isle North Lighthouse',NULL,                       'lighthouse', 'medium', 59.550,  -1.610, 'fair isle'),
  ('Out Skerries Lighthouse',NULL,                          'lighthouse', 'medium', 60.425,  -0.728, 'out skerries'),

  -- Landmarks / sites
  ('Muness Castle',    NULL,                                'landmark',   'medium', 60.705,  -0.872, 'unst'),
  ('Stanydale Temple', NULL,                                'broch',      'medium', 60.232,  -1.510, 'west mainland'),
  ('Old Scatness',     NULL,                                'broch',      'medium', 59.880,  -1.305, 'south mainland'),
  ('Fort Charlotte',   NULL,                                'landmark',   'medium', 60.155,  -1.142, 'central'),
  ('The Knab',         NULL,                                'headland',   'medium', 60.150,  -1.130, 'central'),

  -- Sounds
  ('Colgrave Sound',   NULL,                                'sound',      'medium', 60.625,  -0.900, 'fetlar'),
  ('Sound of Yell',    NULL,                                'sound',      'medium', 60.510,  -1.105, 'yell');

-- ── Seed: HARD tier (~75 places) ────────────────────────────────────────────
-- Real-deal local knowledge: small crofts, named geos, lesser-known voes/lochs.

INSERT INTO public.game_shetland_places (name, alt_names, category, difficulty, lat, lng, region) VALUES
  -- Less-known settlements
  ('Catfirth',         NULL,                                'settlement', 'hard',   60.265,  -1.123, 'central'),
  ('Voxter',           NULL,                                'settlement', 'hard',   60.343,  -1.280, 'north mainland'),
  ('Kergord',          NULL,                                'settlement', 'hard',   60.245,  -1.290, 'central'),
  ('Reawick',          NULL,                                'settlement', 'hard',   60.150,  -1.432, 'west mainland'),
  ('Stove',            NULL,                                'settlement', 'hard',   59.952,  -1.286, 'south mainland'),
  ('Houss',            NULL,                                'settlement', 'hard',   60.075,  -1.318, 'central'),
  ('Hamister',         NULL,                                'settlement', 'hard',   60.357,  -1.018, 'whalsay'),
  ('Isbister',         NULL,                                'settlement', 'hard',   60.385,  -0.945, 'whalsay'),
  ('Vatsetter',        NULL,                                'settlement', 'hard',   60.598,  -1.022, 'yell'),
  ('Cunnister',        NULL,                                'settlement', 'hard',   60.585,  -1.010, 'yell'),
  ('Mailand',          NULL,                                'settlement', 'hard',   60.692,  -1.020, 'yell'),
  ('Hammar',           NULL,                                'settlement', 'hard',   60.745,  -0.882, 'unst'),
  ('Caddafield',       NULL,                                'settlement', 'hard',   60.770,  -0.840, 'unst'),
  ('Burrafirth',       NULL,                                'settlement', 'hard',   60.812,  -0.873, 'unst'),
  ('Sound',            ARRAY['Sound (Lerwick)'],            'settlement', 'hard',   60.137,  -1.157, 'central'),
  ('Easterhoull',      NULL,                                'settlement', 'hard',   60.140,  -1.276, 'central'),

  -- Tiny islands / holms
  ('Bigga',            NULL,                                'island',     'hard',   60.553,  -1.105, 'yell'),
  ('Lamba',            NULL,                                'island',     'hard',   60.518,  -1.190, 'north mainland'),
  ('Samphrey',         NULL,                                'island',     'hard',   60.475,  -1.123, 'north mainland'),
  ('Linga',            ARRAY['Linga (Yell)'],               'island',     'hard',   60.523,  -1.063, 'yell'),
  ('Hascosay',         NULL,                                'island',     'hard',   60.612,  -0.998, 'yell'),
  ('Uyea',             NULL,                                'island',     'hard',   60.695,  -0.965, 'unst'),
  ('Vaila',            NULL,                                'island',     'hard',   60.213,  -1.628, 'west mainland'),
  ('Muckle Roe',       NULL,                                'island',     'hard',   60.380,  -1.453, 'north mainland'),
  ('Havra',            NULL,                                'island',     'hard',   60.075,  -1.275, 'central'),
  ('Hildasay',         NULL,                                'island',     'hard',   60.130,  -1.348, 'central'),

  -- Voes (lesser-known)
  ('Hamna Voe',        ARRAY['Hamnavoe'],                   'voe',        'hard',   60.087,  -1.342, 'central'),
  ('Burra Voe',        ARRAY['Burra Voe (Yell)'],           'voe',        'hard',   60.495,  -1.023, 'yell'),
  ('Tresta Voe',       NULL,                                'voe',        'hard',   60.612,  -0.852, 'fetlar'),
  ('Swarbacks Minn',   NULL,                                'voe',        'hard',   60.350,  -1.500, 'north mainland'),
  ('Cliff Sound',      NULL,                                'sound',      'hard',   60.083,  -1.353, 'central'),
  ('Sand Voe',         NULL,                                'voe',        'hard',   60.518,  -1.420, 'north mainland'),
  ('Quendale Bay',     NULL,                                'voe',        'hard',   59.910,  -1.367, 'south mainland'),
  ('Roe Sound',        NULL,                                'sound',      'hard',   60.395,  -1.435, 'north mainland'),
  ('West Voe of Sumburgh',NULL,                             'voe',        'hard',   59.870,  -1.310, 'south mainland'),
  ('Pool of Virkie',   NULL,                                'voe',        'hard',   59.885,  -1.290, 'south mainland'),
  ('Catfirth Voe',     NULL,                                'voe',        'hard',   60.262,  -1.115, 'central'),

  -- Lochs (lesser-known)
  ('Loch of Watsness', NULL,                                'loch',       'hard',   60.305,  -1.675, 'west mainland'),
  ('Loch of Hellier',  NULL,                                'loch',       'hard',   60.232,  -1.345, 'central'),
  ('Loch of Vatsaund', NULL,                                'loch',       'hard',   60.215,  -1.140, 'central'),
  ('Loch of Snabrough',NULL,                                'loch',       'hard',   60.318,  -1.385, 'central'),
  ('Loch of Houlland', NULL,                                'loch',       'hard',   60.490,  -1.610, 'north mainland'),
  ('Black Loch',       NULL,                                'loch',       'hard',   60.215,  -1.252, 'central'),
  ('Loch of Cunnister',NULL,                                'loch',       'hard',   60.585,  -1.018, 'yell'),
  ('Loch of Skaw',     NULL,                                'loch',       'hard',   60.832,  -0.795, 'unst'),

  -- Beaches & coves
  ('Sands of Sound',   NULL,                                'beach',      'hard',   60.143,  -1.157, 'central'),
  ('Eswick Beach',     NULL,                                'beach',      'hard',   60.293,  -1.118, 'central'),
  ('Tresta Beach',     ARRAY['Tresta Sand'],                'beach',      'hard',   60.617,  -0.857, 'fetlar'),
  ('Wick of Tresta',   NULL,                                'beach',      'hard',   60.610,  -0.852, 'fetlar'),
  ('Mu Ness',          NULL,                                'headland',   'hard',   60.708,  -0.872, 'unst'),
  ('Lamba Ness',       NULL,                                'headland',   'hard',   60.815,  -0.745, 'unst'),

  -- Geos & cliffs
  ('Burgi Geos',       NULL,                                'geo',        'hard',   60.770,  -0.953, 'unst'),
  ('Otter''s Geo',     NULL,                                'geo',        'hard',   60.500,  -1.625, 'north mainland'),
  ('Da Drongs',        ARRAY['The Drongs'],                 'geo',        'hard',   60.470,  -1.585, 'north mainland'),
  ('Kame of Foula',    ARRAY['The Kame'],                   'headland',   'hard',   60.137,  -2.097, 'foula'),
  ('Snolda',           NULL,                                'headland',   'hard',   60.140,  -2.080, 'foula'),
  ('Sheep Rock',       NULL,                                'headland',   'hard',   59.522,  -1.595, 'fair isle'),
  ('Out Stack',        NULL,                                'island',     'hard',   60.847,  -0.873, 'unst'),
  ('Bound Skerry',     NULL,                                'lighthouse', 'hard',   60.428,  -0.728, 'out skerries'),

  -- Hills (lesser)
  ('Sneug',            NULL,                                'hill',       'hard',   60.128,  -2.082, 'foula'),
  ('Ward Hill',        ARRAY['Ward Hill (Fair Isle)'],      'hill',       'hard',   59.535,  -1.640, 'fair isle'),
  ('Royl Field',       NULL,                                'hill',       'hard',   60.080,  -1.272, 'central'),
  ('Scousburgh Hill',  NULL,                                'hill',       'hard',   59.945,  -1.337, 'south mainland'),
  ('Hill of Colvadale',NULL,                                'hill',       'hard',   60.745,  -0.900, 'unst'),

  -- Ancient / curiosities
  ('Bordastubble',     NULL,                                'broch',      'hard',   60.747,  -0.928, 'unst'),
  ('Catpund',          NULL,                                'broch',      'hard',   60.012,  -1.225, 'south mainland'),
  ('Tingaholm',        NULL,                                'landmark',   'hard',   60.197,  -1.241, 'central'),
  ('Bod of Gremista',  NULL,                                'landmark',   'hard',   60.170,  -1.150, 'central'),
  ('The Lodberries',   NULL,                                'landmark',   'hard',   60.151,  -1.140, 'central'),
  ('Twageos',          NULL,                                'landmark',   'hard',   60.150,  -1.135, 'central'),
  ('Catfirth Seaplane Base',NULL,                           'landmark',   'hard',   60.262,  -1.125, 'central'),

  -- Other landmarks
  ('Sandwick Bay',     NULL,                                'voe',        'hard',   60.002,  -1.230, 'south mainland'),
  ('Spiggie Hotel',    NULL,                                'landmark',   'hard',   59.938,  -1.345, 'south mainland'),
  ('Tangwick Haa',     NULL,                                'landmark',   'hard',   60.490,  -1.553, 'north mainland'),
  ('Hellisgill',       NULL,                                'geo',        'hard',   60.480,  -1.633, 'north mainland'),
  ('Lyrawick',         NULL,                                'beach',      'hard',   60.130,  -2.080, 'foula');
