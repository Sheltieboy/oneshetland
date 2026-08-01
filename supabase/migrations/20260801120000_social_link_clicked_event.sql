-- Register the social_link_clicked analytics event (server-logged by the
-- website's /go/* short-link redirect — anonymous click counting for social
-- posts), and clear un-approved drafts so the composer regenerates their
-- captions with the new clean /go/ links.

insert into public.analytics_event_defs (event_name, is_conversion, category, description) values
  ('social_link_clicked', false, 'referral', 'Followed a link from a OneShetland social post (server-logged at /go redirect)')
on conflict (event_name) do nothing;

delete from public.social_posts where status = 'draft';
