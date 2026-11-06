-- Bressay Under 5s: UNDO step 2. Restores the seven event rows to published, removes the URL redirects and returns the activity to draft.
begin;
update public.events set status = 'published'
 where id in ('631c1981-5ddc-834d-9456-1e62a30ce691','28a12d8c-c8be-7398-884a-c0f56842a890','82b66785-b681-99b2-16d9-c8643feaaf2e',
              '03d78c64-c673-b340-8785-b5e2db410511','45d1ba64-f991-6414-4e41-d61318ee8144','00c6df8c-41cc-62d0-6204-a2d91de09229',
              'a2e870ef-c163-bc6b-fb4a-7daf1bbde8c5') and status = 'archived';
delete from public.activity_legacy_events where activity_id = (select id from public.regular_activities where slug = 'bressay-under-5s');
update public.regular_activities set status = 'draft' where slug = 'bressay-under-5s';
commit;
