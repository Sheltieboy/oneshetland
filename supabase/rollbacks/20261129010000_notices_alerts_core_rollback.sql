-- Rollback of 20261129010000_notices_alerts_core. Essential designations and organisation notices lose their special columns (the notices themselves stay,
-- as ordinary platform notices). Roll back 20261129020000+ first (they depend on these columns and functions).
begin;
drop function if exists public.get_essential_alerts(text[]), public.get_public_notices(text, text[], text, integer, integer), public.official_set_notice_status(uuid, text),
  public.official_update_notice(uuid, text, text, text, text[], timestamptz, text, text, boolean, timestamptz),
  public.official_publish_notice(uuid, text, text, text, text[], timestamptz, timestamptz, text, text, boolean, timestamptz),
  public.official_validate_notice(uuid, text, text, text, text[], timestamptz, timestamptz, timestamptz, text, text, boolean), public.is_safe_https_url(text),
  public.admin_revoke_essential_alert(uuid, text);
drop trigger if exists notices_alert_audit on public.notices; drop trigger if exists notices_essential_guard on public.notices;
drop function if exists public.tg_notices_alert_audit(), public.tg_notices_essential_guard();
-- restore the Stage 2 publisher label (no organisation branch)
create or replace function public.notice_publisher_display(p_notice uuid) returns jsonb language sql stable security invoker set search_path to 'public', 'pg_temp' as $f$
  select case
    when n.is_platform_notice and n.source is not null then jsonb_build_object('kind', 'platform', 'label', n.source_label, 'is_official_source', true, 'source_label', n.source_label, 'source_url', n.source_url, 'byline', 'Source: ' || n.source_label)
    when n.is_platform_notice then jsonb_build_object('kind', 'platform', 'label', 'OneShetland', 'is_official_source', false, 'source_label', null, 'source_url', null, 'byline', 'Posted by OneShetland')
    when n.is_person_notice then jsonb_build_object('kind', 'person', 'label', public.notice_person_label(n.publisher_user_id), 'is_official_source', false, 'source_label', null, 'source_url', null, 'byline', 'Posted by ' || public.notice_person_label(n.publisher_user_id))
    when n.publisher_hub_id is not null then jsonb_build_object('kind', 'hub', 'label', coalesce((select name from public.hubs h where h.id = n.publisher_hub_id), 'Community hub'), 'is_official_source', false, 'source_label', null, 'source_url', null, 'byline', 'Posted by ' || coalesce((select name from public.hubs h where h.id = n.publisher_hub_id), 'Community hub'))
    else jsonb_build_object('kind', 'business', 'label', coalesce((select name from public.local_businesses b where b.id = n.publisher_business_id), 'Local business'), 'is_official_source', false, 'source_label', null, 'source_url', null, 'byline', 'Posted by ' || coalesce((select name from public.local_businesses b where b.id = n.publisher_business_id), 'Local business'))
  end from public.notices n where n.id = p_notice; $f$;
drop function if exists public.official_publisher_label(uuid), public.notice_matches_areas(uuid, text[]), public.area_neighbourhood(text[]), public.notice_essential_active(public.notices), public.notice_is_public(public.notices);
drop index if exists public.notices_feed_idx, public.notices_essential_idx, public.notices_official_idx;
alter table public.notices drop constraint if exists notices_review_before_expiry, drop constraint if exists notices_essential_check, drop constraint if exists notices_link_url_check, drop constraint if exists notices_official_publisher_check;
alter table public.notices drop column if exists essential_set_at, drop column if exists essential_set_by, drop column if exists link_url, drop column if exists review_at, drop column if exists action_text,
  drop column if exists is_essential, drop column if exists official_publisher_id;
commit;
