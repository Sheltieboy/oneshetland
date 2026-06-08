-- ── load.sql — one-shot seed loader for Da Boats ───────────────────────────
--
-- Streams every CSV in this directory into the matching table via psql's
-- client-side \copy meta-command. Far less tedious than 13 dashboard
-- imports in order, and faster too.
--
-- Run from this directory:
--
--   cd supabase/seed-data/da-boats
--   psql "<your-supabase-connection-string>" -f load.sql
--
-- Get the connection string from:
--   Supabase dashboard → Project Settings → Database → Connection string
--   (use the Session pooler URL — works from anywhere)
--
-- If you don't have psql installed:
--   macOS:   brew install libpq && brew link --force libpq
--   or use Postgres.app:  https://postgresapp.com
--
-- Order matters — FK constraints will reject rows whose parents aren't
-- in yet, so the sequence below mirrors the import order from
-- README.md.

\set ON_ERROR_STOP on

BEGIN;

\copy public.source_documents      (id, slug, title, source_type, publisher, url, accessed_on, notes)                                                                                       FROM 'source_documents.csv'      WITH (FORMAT csv, HEADER true);
\copy public.source_records        (id, source_document_id, record_type, external_ref, source_page, record_date_text, raw_text, payload, extraction_notes)                                  FROM 'source_records.csv'        WITH (FORMAT csv, HEADER true);
\copy public.media_assets          (id, source_document_id, source_record_id, asset_type, title, external_ref, image_url, thumbnail_url, page_url, rights_note, payload)                    FROM 'media_assets.csv'          WITH (FORMAT csv, HEADER true);
\copy public.vessels               (id, vessel_key, canonical_name, primary_lk_number, built_year, built_decade, builder, yard_number, hull_material, country_of_build, status, identity_confidence, identity_notes, source_family) FROM 'vessels.csv'               WITH (FORMAT csv, HEADER true);
\copy public.vessel_source_links   (id, vessel_id, source_record_id, confidence, relationship_type, notes)                                                                                  FROM 'vessel_source_links.csv'   WITH (FORMAT csv, HEADER true);
\copy public.vessel_names          (id, vessel_id, name, normalised_name, start_year, end_year, date_text, is_primary, confidence, source_record_id)                                        FROM 'vessel_names.csv'          WITH (FORMAT csv, HEADER true);
\copy public.registrations         (id, vessel_id, registration, port_mark, registration_number, start_year, end_year, date_text, is_primary, confidence, source_record_id)                 FROM 'registrations.csv'         WITH (FORMAT csv, HEADER true);
\copy public.owners                (id, name, normalised_name, notes)                                                                                                                       FROM 'owners.csv'                WITH (FORMAT csv, HEADER true);
\copy public.ownership_periods     (id, vessel_id, owner_id, start_year, end_year, date_text, confidence, source_record_id, notes)                                                          FROM 'ownership_periods.csv'     WITH (FORMAT csv, HEADER true);
\copy public.vessel_events         (id, vessel_id, event_type, event_year, event_date_text, description, location, confidence, source_record_id)                                            FROM 'vessel_events.csv'         WITH (FORMAT csv, HEADER true);
\copy public.measurements          (id, vessel_id, measurement_year, length_m, tonnage, tonnage_type, tonnage_text, engine_power_kw, capacity_units, source_record_id, notes)               FROM 'measurements.csv'          WITH (FORMAT csv, HEADER true);
\copy public.vessel_relationships  (id, vessel_id, related_vessel_id, relationship_type, confidence, source_record_id, notes)                                                               FROM 'vessel_relationships.csv'  WITH (FORMAT csv, HEADER true);
\copy public.vessel_media_links    (id, vessel_id, media_asset_id, source_record_id, confidence, notes)                                                                                     FROM 'vessel_media_links.csv'    WITH (FORMAT csv, HEADER true);

COMMIT;

\echo ''
\echo '✓ Da Boats seed loaded.'
\echo ''
\echo 'Verify with:'
\echo '  SELECT COUNT(*) FROM public.vessels;             -- expect 467'
\echo '  SELECT COUNT(*) FROM public.vessel_events;       -- expect 2639'
\echo '  SELECT COUNT(*) FROM public.media_assets;        -- expect 369'
