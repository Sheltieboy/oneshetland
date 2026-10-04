-- 4 Oct 2026 — the one genuine public notice (applied to production by hand, recorded here).
--
-- WHY: production had zero real public notices, so App Store build 144 fell back to SAMPLE_NOTICES and showed
-- invented news ("Yell ferry — Tuesday evening sailings cancelled", a lost dog, library hours) as if real. Build 144
-- shows any real notice instead, so one truthful notice from OneShetland itself ends the fallback.
--
-- HOW the notice model carries "OneShetland": a notice names its publisher through hub / business / user, and
-- build 144 prints the hub's name. A user publisher prints as "Member", which would be wrong. So OneShetland gets
-- its own platform hub (owner: the darren@oneshetland.com admin account). It is OneShetland's own identity; no other
-- organisation is named.
--
-- KEEP this notice (never expire it) until the first real public notices exist; deleting it earlier brings the
-- invented samples back in build 144.
begin;
with h as (
  insert into hubs (owner_id, name, slug, type, join_mode, is_active, directory_enabled, description)
  values ('eb599396-6e9c-4c49-ae67-cb60fbc02bac', 'OneShetland', 'oneshetland', 'other', 'approval', true, false,
          'Announcements from the OneShetland team.')
  returning id)
insert into notices (publisher_hub_id, severity, title, body, visibility, is_pinned)
select id, 'info', 'OneShetland is getting ready to launch',
       'We’re putting the final touches to OneShetland and adding local businesses, events and useful information. Thanks for taking an early look.',
       'public', false
  from h;
commit;
