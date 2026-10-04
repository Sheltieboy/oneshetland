-- Reverts 20261104_launch_notice.sql: removes the notice and the OneShetland hub (and its owner-membership row).
-- WARNING: with no real public notice, build 144 shows its invented sample notices again.
begin;
delete from notices where title = 'OneShetland is getting ready to launch'
  and publisher_hub_id = (select id from hubs where slug = 'oneshetland' and name = 'OneShetland');
delete from hub_members where hub_id = (select id from hubs where slug = 'oneshetland' and name = 'OneShetland');
delete from hubs where slug = 'oneshetland' and name = 'OneShetland';
commit;
