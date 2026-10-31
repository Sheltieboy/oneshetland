-- Rollback of 20261129040000_notice_imports. Destroys import configuration, items and run history (imported NOTICES are kept: they are ordinary notices).
begin;
drop function if exists public.import_finish_run(uuid, text, integer, integer, integer, integer, integer, text), public.import_upsert_notice(text, text, text, text, text, timestamptz, text, text[], timestamptz),
  public.import_start_run(text), public.admin_import_status(), public.admin_retire_import_source(text, uuid, boolean), public.admin_set_import_source_enabled(text, boolean, text),
  public.admin_upsert_import_source(text, text, text, text, text[], text, text[], integer, integer);
drop table if exists public.notice_import_runs, public.notice_import_items, public.notice_import_sources;
commit;
