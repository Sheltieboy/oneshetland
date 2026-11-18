-- Admin Intelligence Dashboard: overview RPC + rules-based "Useful Actions" with persisted state.
--
-- LOCAL ONLY. Not applied anywhere. Purely additive: two new tables (admin-only, no client access), five new functions.
-- Changes no existing table, policy, function or data. Reads existing tables only.
--
-- ACCESS: every callable function checks public.is_admin() (the same predicate the existing analytics RPCs use) and raises
-- 42501 otherwise. Tables have RLS enabled with NO policies and all privileges revoked from anon/authenticated, so nothing is
-- reachable except through these definer functions. The web layer additionally gates on requireAdmin().
--
-- PRIVACY: results are aggregates, or public business/hub names (already public listings). No member ids, emails or
-- individual behaviour are returned. My Saved is reported as counts only.
--
-- ACCURACY RULES used throughout:
--   * "day" boundaries are Europe/London.
--   * businesses/hubs listed in discovery_fixtures (ZZ/DEMO fixtures) are excluded from every count and every sample.
--   * a metric that cannot be measured from existing data is listed in `unavailable`, never estimated.

-- ── 1. Persisted state for Useful Actions ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.admin_action_state (
  action_key      text primary key,
  status          text not null check (status in ('done', 'dismissed', 'snoozed')),
  snooze_until    timestamptz,
  evidence_value  numeric,           -- the rule's measured value when the admin acted; a rise above it is "new evidence"
  better          text check (better in ('lower', 'higher')),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create table if not exists public.admin_action_log (
  id              bigint generated always as identity primary key,
  action_key      text not null,
  status          text not null,
  evidence_value  numeric,
  better          text,
  title           text,
  acted_by        uuid,
  acted_at        timestamptz not null default now()
);
create index if not exists idx_admin_action_log_acted_at on public.admin_action_log (acted_at desc);

alter table public.admin_action_state enable row level security;
alter table public.admin_action_log enable row level security;
revoke all on public.admin_action_state from anon, authenticated;
revoke all on public.admin_action_log from anon, authenticated;

-- ── 2. Helper: one rule as jsonb ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_intel_rule(
  p_key text, p_triggered boolean, p_value numeric, p_better text, p_priority text, p_category text,
  p_title text, p_what text, p_why text, p_benefit text, p_link text, p_evidence text, p_items jsonb default '[]'::jsonb
) returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'key', p_key, 'triggered', coalesce(p_triggered, false), 'value', coalesce(p_value, 0), 'better', p_better,
    'priority', p_priority, 'category', p_category, 'title', p_title, 'what', p_what, 'why', p_why, 'benefit', p_benefit,
    'link', p_link, 'evidence', p_evidence, 'items', coalesce(p_items, '[]'::jsonb));
$$;
revoke execute on function public.admin_intel_rule(text, boolean, numeric, text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;

-- ── 3. All rules, evaluated against live data (internal; no gate, not granted to clients) ───────────────────────────────
create or replace function public.admin_intel_rules_raw() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r jsonb := '[]'::jsonb;
  v_n numeric; v_old timestamptz; v_ok boolean; v_ran timestamptz; v_items jsonb;
begin
  -- Pending business claims
  select count(*), min(created_at) into v_n, v_old from business_claims where status = 'pending';
  r := r || public.admin_intel_rule('claims_pending', v_n > 0, v_n, 'lower',
    case when v_old < now() - interval '3 days' then 'urgent' else 'high' end, 'operations',
    'Review business claims awaiting approval',
    'Open the claims queue and approve or reject each pending claim.',
    v_n::int || ' claim(s) pending' || case when v_old is not null then '; oldest waiting ' || greatest(0, extract(day from now() - v_old))::int || ' day(s)' else '' end || '.',
    'Owners who claim a listing can start publishing; slow replies lose them.', '/admin/claims', 'measured');

  -- Pending event submissions
  select count(*), min(created_at) into v_n, v_old from event_submissions where status = 'pending';
  r := r || public.admin_intel_rule('event_submissions_pending', v_n > 0, v_n, 'lower',
    case when v_old < now() - interval '2 days' then 'urgent' else 'high' end, 'operations',
    'Review member event submissions',
    'Approve, reject or request changes on submitted events.',
    v_n::int || ' submission(s) pending' || case when v_old is not null then '; oldest waiting ' || greatest(0, extract(day from now() - v_old))::int || ' day(s)' else '' end || '.',
    'Keeps What''s On current and shows members that submitting is worthwhile.', '/admin/events/submissions', 'measured');

  -- Open content reports
  select count(*), min(created_at) into v_n, v_old from content_reports where status in ('open', 'reviewing');
  r := r || public.admin_intel_rule('reports_open', v_n > 0, v_n, 'lower',
    case when v_old < now() - interval '1 day' then 'urgent' else 'high' end, 'operations',
    'Work through open content reports',
    'Review reported content and action or dismiss each report.',
    v_n::int || ' open report(s)' || case when v_old is not null then '; oldest ' || greatest(0, extract(day from now() - v_old))::int || ' day(s) old' else '' end || '.',
    'Safety and trust: reports left unanswered undermine the Terms promise.', '/admin/reports', 'measured');

  -- Council job sync freshness / failure (runs every 3 hours)
  select ran_at, ok into v_ran, v_ok from job_sync_runs order by ran_at desc limit 1;
  r := r || public.admin_intel_rule('job_sync_unhealthy',
    v_ran is not null and (v_ok is not true or v_ran < now() - interval '8 hours'),
    case when v_ran is null then 0 else round(extract(epoch from now() - v_ran) / 3600) end, 'lower', 'urgent', 'operations',
    'Check the council jobs sync',
    'The most recent council jobs sync failed or is overdue. Check the function logs and the council site.',
    case when v_ran is null then 'No sync runs recorded.' else 'Last run ' || round(extract(epoch from now() - v_ran) / 3600)::int || ' hour(s) ago; last result ' || case when v_ok then 'ok' else 'FAILED' end || '.' end,
    'Members rely on current job listings; stale jobs hurt trust.', '/jobs', 'measured');

  -- Email delivery failures (7 days)
  select count(*) into v_n from email_log where status in ('failed', 'bounced') and sent_at > now() - interval '7 days';
  r := r || public.admin_intel_rule('email_failures_7d', v_n > 0, v_n, 'lower',
    case when v_n >= 5 then 'high' else 'medium' end, 'operations',
    'Investigate failed or bounced emails',
    'Open the Email Centre and check recent failures and bounces.',
    v_n::int || ' failed/bounced email(s) in the last 7 days.',
    'Transactional emails (receipts, claims, resets) are part of member trust.', '/admin/email', 'measured');

  -- Push notification errors (7 days)
  select count(*) into v_n from notification_log where status = 'error' and created_at > now() - interval '7 days';
  r := r || public.admin_intel_rule('notification_errors_7d', v_n >= 5, v_n, 'lower', 'medium', 'operations',
    'Look into push notification errors',
    'Several notifications failed to send recently. Check the sender logs.',
    v_n::int || ' push notification error(s) in the last 7 days (shown from 5 or more).',
    'Reminders and alerts only work if they are delivered.', '/admin/alerts', 'measured');

  -- Analytics ingestion silent
  select max(occurred_at) into v_ran from analytics_events;
  r := r || public.admin_intel_rule('analytics_silent', v_ran is null or v_ran < now() - interval '3 days',
    case when v_ran is null then 999 else extract(day from now() - v_ran) end, 'lower', 'high', 'operations',
    'Analytics events have stopped arriving',
    'No analytics events were recorded recently. Check consent banner behaviour and the log_events call.',
    case when v_ran is null then 'No analytics events have ever been recorded.' else 'Last event received ' || extract(day from now() - v_ran)::int || ' day(s) ago.' end,
    'Every engagement metric on this dashboard depends on these events.', '/admin/analytics', 'measured');

  -- Incomplete owner-managed listings
  select count(*) into v_n from local_businesses b
   where b.is_active and b.is_claimed
     and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id)
     and (coalesce(length(trim(b.description)), 0) < 40 or b.logo_url is null
          or (b.phone is null and b.website is null and b.email is null));
  select coalesce(jsonb_agg(jsonb_build_object('label', x.name, 'href', '/directory/' || coalesce(x.slug, x.id::text))), '[]'::jsonb) into v_items
    from (select b.name, b.slug, b.id from local_businesses b
           where b.is_active and b.is_claimed
             and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id)
             and (coalesce(length(trim(b.description)), 0) < 40 or b.logo_url is null
                  or (b.phone is null and b.website is null and b.email is null))
           order by b.claimed_at desc nulls last limit 5) x;
  r := r || public.admin_intel_rule('listings_incomplete', v_n > 0, v_n, 'lower', 'medium', 'quality',
    'Improve incomplete business listings',
    'Contact owners whose claimed listings lack a real description (40+ characters), a logo or any contact route.',
    v_n::int || ' claimed active listing(s) are missing a description, logo or contact details.',
    'Complete listings are more useful to members and more likely to lead to a paid plan.', '/admin/claims', 'measured', v_items);

  -- Unclaimed listings (growth)
  select count(*) into v_n from local_businesses b
   where b.is_active and not b.is_claimed
     and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id);
  r := r || public.admin_intel_rule('unclaimed_listings', v_n >= 25, v_n, 'lower', 'low', 'growth',
    'Invite owners to claim their listings',
    'Use the launch-partner pipeline to invite owners of well-known unclaimed listings (post or visit for sole traders).',
    v_n::int || ' active listing(s) are still unclaimed (shown from 25).',
    'Claimed listings can be kept accurate by their owners and can upgrade.', '/admin/launch-partners', 'measured');

  -- Thin upcoming event coverage (14 days). The threshold is a judgement call, not a benchmark.
  select count(*) into v_n from events e
   where e.status = 'published' and not e.is_hidden and e.starts_at >= now() and e.starts_at < now() + interval '14 days';
  r := r || public.admin_intel_rule('event_coverage_thin', v_n < 8, v_n, 'higher',
    case when v_n < 3 then 'high' else 'medium' end, 'growth',
    'Add events for the next two weeks',
    'What''s On looks thin. Add events, or encourage organisers and Hubs to post.',
    v_n::int || ' published event(s) start in the next 14 days (flagged below 8; the threshold is a judgement call).',
    'A full What''s On is the main reason members return.', '/admin/events', 'measured');

  -- Jobs still open past their expiry
  select count(*) into v_n from jobs j where j.status = 'open' and not j.is_hidden and j.expires_at is not null and j.expires_at < now();
  r := r || public.admin_intel_rule('jobs_expired_open', v_n > 0, v_n, 'lower', 'medium', 'quality',
    'Close jobs that have passed their expiry',
    'Some jobs are still marked open after their expiry date.',
    v_n::int || ' job(s) are open but expired.',
    'Members lose trust in listings that are already closed.', '/jobs', 'measured');

  -- Offers expiring within 7 days
  select count(*) into v_n from local_offers o
   where o.is_active and o.valid_until is not null and o.valid_until >= now() and o.valid_until < now() + interval '7 days';
  r := r || public.admin_intel_rule('offers_expiring', v_n > 0, v_n, 'lower', 'low', 'quality',
    'Offers are about to expire',
    'Remind the businesses to renew or replace these offers.',
    v_n::int || ' active offer(s) end within 7 days.',
    'Keeps the Offers section populated and gives businesses a reason to return.', '/local', 'measured');

  -- Quiet hubs (no events, notices or activities in 60 days; hub at least 30 days old)
  select count(*) into v_n from hubs h
   where h.is_active and h.created_at < now() - interval '30 days'
     and not exists (select 1 from discovery_fixtures f where f.entity = 'hub' and f.entity_id = h.id)
     and not exists (select 1 from events e where e.organiser_hub_id = h.id and e.created_at > now() - interval '60 days')
     and not exists (select 1 from notices n where n.publisher_hub_id = h.id and n.created_at > now() - interval '60 days')
     and not exists (select 1 from regular_activities a where a.organiser_hub_id = h.id and a.updated_at > now() - interval '60 days');
  select coalesce(jsonb_agg(jsonb_build_object('label', x.name, 'href', '/hubs/' || coalesce(x.slug, x.id::text))), '[]'::jsonb) into v_items
    from (select h.name, h.slug, h.id from hubs h
           where h.is_active and h.created_at < now() - interval '30 days'
             and not exists (select 1 from discovery_fixtures f where f.entity = 'hub' and f.entity_id = h.id)
             and not exists (select 1 from events e where e.organiser_hub_id = h.id and e.created_at > now() - interval '60 days')
             and not exists (select 1 from notices n where n.publisher_hub_id = h.id and n.created_at > now() - interval '60 days')
             and not exists (select 1 from regular_activities a where a.organiser_hub_id = h.id and a.updated_at > now() - interval '60 days')
           order by h.created_at limit 5) x;
  r := r || public.admin_intel_rule('hubs_quiet', v_n > 0, v_n, 'lower', 'medium', 'growth',
    'Nudge Hubs that have gone quiet',
    'Contact these Hubs and offer help posting an event, activity or notice.',
    v_n::int || ' active Hub(s) have published no event, notice or activity in 60 days.',
    'Active Hubs are where much of the local events and activity content comes from.', '/admin/events/community', 'measured', v_items);

  -- Paid plans ending (cancel at period end, within 14 days)
  select count(*) into v_n from local_businesses b
   where b.subscription_tier in ('pro', 'premium') and b.subscription_cancel_at_period_end
     and b.subscription_until >= now() and b.subscription_until < now() + interval '14 days'
     and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id);
  r := r || public.admin_intel_rule('subs_ending', v_n > 0, v_n, 'lower', 'medium', 'commercial',
    'Speak to businesses whose paid plan is ending',
    'These businesses have cancelled and their plan ends within 14 days. Ask why and whether anything would keep them.',
    v_n::int || ' paid plan(s) set to cancel within 14 days.',
    'Retention feedback is the cheapest way to learn what paid plans are missing.', '/admin/payments', 'measured');

  -- Paid tier recorded but period elapsed (possible webhook/billing problem)
  select count(*) into v_n from local_businesses b
   where b.subscription_tier in ('pro', 'premium') and b.subscription_until is not null and b.subscription_until < now() - interval '2 days'
     and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id);
  r := r || public.admin_intel_rule('subs_lapsed_unreconciled', v_n > 0, v_n, 'lower', 'high', 'operations',
    'Check paid plans past their end date',
    'These businesses still show a paid tier although the period ended over 2 days ago. Check Stripe and the webhook before taking action.',
    v_n::int || ' business(es) show a paid tier with an elapsed period.',
    'Either a billing sync problem or free access that was not intended.', '/admin/payments', 'measured');

  -- Upgrade candidates: free, claimed, complete profile, publishing in the last 60 days. HEURISTIC.
  select count(*) into v_n from local_businesses b
   where b.is_active and b.is_claimed and coalesce(b.subscription_tier, 'free') = 'free'
     and coalesce(length(trim(b.description)), 0) >= 40 and b.logo_url is not null
     and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id)
     and (exists (select 1 from events e where e.organiser_business_id = b.id and e.created_at > now() - interval '60 days')
          or exists (select 1 from local_offers o where o.business_id = b.id and o.created_at > now() - interval '60 days')
          or exists (select 1 from jobs j where j.posted_as_business_id = b.id and j.created_at > now() - interval '60 days'));
  select coalesce(jsonb_agg(jsonb_build_object('label', x.name, 'href', '/directory/' || coalesce(x.slug, x.id::text))), '[]'::jsonb) into v_items
    from (select b.name, b.slug, b.id from local_businesses b
           where b.is_active and b.is_claimed and coalesce(b.subscription_tier, 'free') = 'free'
             and coalesce(length(trim(b.description)), 0) >= 40 and b.logo_url is not null
             and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id)
             and (exists (select 1 from events e where e.organiser_business_id = b.id and e.created_at > now() - interval '60 days')
                  or exists (select 1 from local_offers o where o.business_id = b.id and o.created_at > now() - interval '60 days')
                  or exists (select 1 from jobs j where j.posted_as_business_id = b.id and j.created_at > now() - interval '60 days'))
           order by b.claimed_at desc nulls last limit 5) x;
  r := r || public.admin_intel_rule('upgrade_candidates', v_n > 0, v_n, 'higher', 'low', 'commercial',
    'Consider these free businesses for a paid-plan conversation',
    'Complete, claimed, free-tier businesses that published an event, offer or job in the last 60 days may value paid publishing tools.',
    v_n::int || ' business(es) match. This is a heuristic (activity + completeness), not evidence of intent.',
    'Targeted outreach to already-active businesses is the lowest-effort path to paid conversions.', '/admin/payments', 'partial', v_items);

  -- Category interest vs supply (consented analytics + upcoming events). PARTIAL evidence.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('label', c.category || ' (' || c.views || ' views, ' || c.upcoming || ' upcoming)', 'href', '/admin/events')), '[]'::jsonb)
    into v_n, v_items
    from (select e.category, count(*) as views,
                 (select count(*) from events e2 where e2.category = e.category and e2.status = 'published' and not e2.is_hidden and e2.starts_at >= now()) as upcoming
            from analytics_events ae
            join events e on e.id::text = ae.object_id
           where ae.event_name = 'content_viewed' and ae.object_type = 'event' and ae.occurred_at > now() - interval '30 days'
             and e.category is not null
           group by e.category) c
   where c.views >= 20 and c.upcoming <= 2;
  r := r || public.admin_intel_rule('category_demand_gap', v_n > 0, v_n, 'lower', 'medium', 'growth',
    'Add events in categories members are viewing',
    'These event categories get views but have few upcoming events.',
    v_n::int || ' categor' || case when v_n = 1 then 'y has' else 'ies have' end || ' 20+ views in 30 days and 2 or fewer upcoming events. Based on consented traffic only, so it understates real interest.',
    'Matching supply to demand gives members a reason to come back.', '/admin/events', 'partial', v_items);

  return r;
end $$;
revoke execute on function public.admin_intel_rules_raw() from public, anon, authenticated;

-- ── 4. Useful Actions (gated) ────────────────────────────────────────────────────────────────────────────────────────────
-- Visibility: an action with no state is shown. 'snoozed' hides until snooze_until. 'done'/'dismissed' hide until the rule's
-- measured value moves the wrong way past what was recorded (new evidence): done = any rise (lower-better) or fall
-- (higher-better); dismissed = a rise of 25% and at least 3.
create or replace function public.admin_useful_actions() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_raw jsonb; v_active jsonb; v_hist jsonb;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'Admin only' using errcode = '42501'; end if;
  v_raw := public.admin_intel_rules_raw();

  select coalesce(jsonb_agg(x.rule || jsonb_build_object('score', x.score, 'state', x.st) order by x.score desc), '[]'::jsonb) into v_active
  from (
    select rule, s.status as st,
           (case rule ->> 'priority' when 'urgent' then 100 when 'high' then 70 when 'medium' then 40 else 20 end
            + least(((rule ->> 'value')::numeric), 50) / 10
            + case rule ->> 'evidence' when 'measured' then 5 else 0 end)::numeric as score
      from jsonb_array_elements(v_raw) rule
      left join public.admin_action_state s on s.action_key = rule ->> 'key'
     where (rule ->> 'triggered')::boolean
       and (s.action_key is null
            or (s.status = 'snoozed' and s.snooze_until <= now())
            or (s.status = 'done' and (
                  (coalesce(s.better, rule ->> 'better') = 'lower'  and (rule ->> 'value')::numeric > coalesce(s.evidence_value, 0))
               or (coalesce(s.better, rule ->> 'better') = 'higher' and (rule ->> 'value')::numeric < coalesce(s.evidence_value, 0))))
            or (s.status = 'dismissed' and coalesce(s.better, rule ->> 'better') = 'lower'
                  and (rule ->> 'value')::numeric >= coalesce(s.evidence_value, 0) * 1.25
                  and (rule ->> 'value')::numeric >= coalesce(s.evidence_value, 0) + 3)
            or (s.status = 'dismissed' and coalesce(s.better, rule ->> 'better') = 'higher'
                  and (rule ->> 'value')::numeric <= coalesce(s.evidence_value, 0) * 0.75))
  ) x;

  select coalesce(jsonb_agg(h order by (h ->> 'acted_at') desc), '[]'::jsonb) into v_hist
  from (
    select jsonb_build_object(
      'key', s.action_key, 'status', s.status, 'acted_at', s.updated_at,
      'title', coalesce(rule ->> 'title', s.action_key),
      'then', s.evidence_value, 'now', case when rule is null then null else (rule ->> 'value')::numeric end,
      'improved', case
          when rule is null or s.evidence_value is null then null
          when s.better = 'higher' then (rule ->> 'value')::numeric > s.evidence_value
          else (rule ->> 'value')::numeric < s.evidence_value end) as h
      from public.admin_action_state s
      left join lateral (select r2 as rule from jsonb_array_elements(v_raw) r2 where r2 ->> 'key' = s.action_key limit 1) l on true
     where s.status in ('done', 'dismissed')
     order by s.updated_at desc limit 20
  ) q;

  return jsonb_build_object('generated_at', now(), 'actions', v_active, 'history', v_hist,
    'snoozed', (select count(*) from public.admin_action_state where status = 'snoozed' and snooze_until > now()));
end $$;

create or replace function public.admin_action_set_state(p_key text, p_status text, p_snooze_days int default 7) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rule jsonb; v_val numeric; v_better text; v_title text;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'Admin only' using errcode = '42501'; end if;
  if p_status not in ('done', 'dismissed', 'snoozed', 'reopen') then raise exception 'Unknown status' using errcode = '22023'; end if;
  select r2 into v_rule from jsonb_array_elements(public.admin_intel_rules_raw()) r2 where r2 ->> 'key' = p_key limit 1;
  if v_rule is null then raise exception 'Unknown action' using errcode = '22023'; end if;

  if p_status = 'reopen' then
    delete from public.admin_action_state where action_key = p_key;
    return;
  end if;
  v_val := (v_rule ->> 'value')::numeric; v_better := v_rule ->> 'better'; v_title := v_rule ->> 'title';
  insert into public.admin_action_state as s (action_key, status, snooze_until, evidence_value, better, updated_by, updated_at)
  values (p_key, p_status,
          case when p_status = 'snoozed' then now() + make_interval(days => greatest(1, least(coalesce(p_snooze_days, 7), 90))) end,
          v_val, v_better, auth.uid(), now())
  on conflict (action_key) do update
     set status = excluded.status, snooze_until = excluded.snooze_until, evidence_value = excluded.evidence_value,
         better = excluded.better, updated_by = excluded.updated_by, updated_at = now();
  insert into public.admin_action_log (action_key, status, evidence_value, better, title, acted_by)
  values (p_key, p_status, v_val, v_better, v_title, auth.uid());
end $$;

-- ── 5. Overview ─────────────────────────────────────────────────────────────────────────────────────────────────────────
-- p_days: 7 | 30 | 90 (clamped 1..365). Current period = [now - p_days, now), previous = [now - 2p_days, now - p_days).
create or replace function public.admin_intel_overview(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d int := greatest(1, least(coalesce(p_days, 30), 365));
  t_cur timestamptz := now() - make_interval(days => d);
  t_prev timestamptz := now() - make_interval(days => 2 * d);
  today_l date := (now() at time zone 'Europe/London')::date;
  v jsonb := '{}'::jsonb;
  m jsonb; b jsonb; c jsonb; s jsonb; k jsonb; h jsonb; e jsonb;
  n_members int; n_cur int; n_prev int;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'Admin only' using errcode = '42501'; end if;

  -- MEMBERS
  select count(*) into n_members from profiles where coalesce(is_active, true);
  select count(*) filter (where created_at >= t_cur), count(*) filter (where created_at >= t_prev and created_at < t_cur) into n_cur, n_prev
    from profiles where coalesce(is_active, true);
  m := jsonb_build_object(
    'total', n_members, 'new_period', n_cur, 'new_prev', n_prev,
    'new_today', (select count(*) from profiles where coalesce(is_active, true) and (created_at at time zone 'Europe/London')::date = today_l),
    'new_7d', (select count(*) from profiles where coalesce(is_active, true) and created_at >= now() - interval '7 days'),
    'new_30d', (select count(*) from profiles where coalesce(is_active, true) and created_at >= now() - interval '30 days'),
    'verified_email', (select count(*) from profiles where coalesce(is_active, true) and email_verified),
    'signed_in_period', (select count(*) from auth.users u join profiles p on p.id = u.id where coalesce(p.is_active, true) and u.last_sign_in_at >= t_cur),
    'with_push', (select count(distinct user_id) from push_tokens),
    'signups_by_day', coalesce((select jsonb_agg(jsonb_build_object('day', g.day, 'n', coalesce(q.n, 0)) order by g.day)
        from generate_series((today_l - (least(d, 90) - 1))::timestamp, today_l::timestamp, interval '1 day') as g(day)
        left join (select (created_at at time zone 'Europe/London')::date as day, count(*) as n from profiles
                    where coalesce(is_active, true) and created_at >= now() - make_interval(days => least(d, 90) + 1) group by 1) q on q.day = g.day::date), '[]'::jsonb));

  -- TRACKED ENGAGEMENT (consented first-party analytics only; excludes admin accounts; partial by nature)
  e := jsonb_build_object(
    'events_period', (select count(*) from analytics_events a where a.occurred_at >= t_cur and not exists (select 1 from profiles p where p.id = a.user_id and (p.role = 'admin' or p.is_platform_owner))),
    'events_prev', (select count(*) from analytics_events a where a.occurred_at >= t_prev and a.occurred_at < t_cur and not exists (select 1 from profiles p where p.id = a.user_id and (p.role = 'admin' or p.is_platform_owner))),
    'dau', (select count(distinct coalesce(a.user_id::text, a.anon_id)) from analytics_events a where a.occurred_at >= now() - interval '1 day' and not exists (select 1 from profiles p where p.id = a.user_id and (p.role = 'admin' or p.is_platform_owner))),
    'wau', (select count(distinct coalesce(a.user_id::text, a.anon_id)) from analytics_events a where a.occurred_at >= now() - interval '7 days' and not exists (select 1 from profiles p where p.id = a.user_id and (p.role = 'admin' or p.is_platform_owner))),
    'mau', (select count(distinct coalesce(a.user_id::text, a.anon_id)) from analytics_events a where a.occurred_at >= now() - interval '30 days' and not exists (select 1 from profiles p where p.id = a.user_id and (p.role = 'admin' or p.is_platform_owner))),
    'returning_7d', (select count(*) from (
        select distinct coalesce(a.user_id::text, a.anon_id) as k from analytics_events a where a.occurred_at >= now() - interval '7 days' and coalesce(a.user_id::text, a.anon_id) is not null) cur
        where exists (select 1 from analytics_events a2 where coalesce(a2.user_id::text, a2.anon_id) = cur.k and a2.occurred_at >= now() - interval '14 days' and a2.occurred_at < now() - interval '7 days')),
    'by_platform', coalesce((select jsonb_object_agg(platform, n) from (select coalesce(platform, 'unknown') as platform, count(*) as n from analytics_events where occurred_at >= t_cur group by 1) z), '{}'::jsonb),
    'content_views', coalesce((select jsonb_agg(jsonb_build_object('type', object_type, 'cur', cur, 'prev', prev) order by cur desc) from (
        select object_type, count(*) filter (where occurred_at >= t_cur) as cur, count(*) filter (where occurred_at >= t_prev and occurred_at < t_cur) as prev
          from analytics_events where event_name = 'content_viewed' and occurred_at >= t_prev and object_type is not null group by 1) z), '[]'::jsonb),
    'contact_clicks', jsonb_build_object('cur', (select count(*) from analytics_events where event_name = 'contact_clicked' and occurred_at >= t_cur),
                                         'prev', (select count(*) from analytics_events where event_name = 'contact_clicked' and occurred_at >= t_prev and occurred_at < t_cur)),
    'searches', jsonb_build_object('cur', (select count(*) from analytics_events where event_name = 'search_performed' and occurred_at >= t_cur),
                                   'prev', (select count(*) from analytics_events where event_name = 'search_performed' and occurred_at >= t_prev and occurred_at < t_cur)),
    'last_event_at', (select max(occurred_at) from analytics_events));

  -- BUSINESSES
  b := jsonb_build_object(
    'active', (select count(*) from local_businesses x where x.is_active and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'claimed', (select count(*) from local_businesses x where x.is_active and x.is_claimed and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'unclaimed', (select count(*) from local_businesses x where x.is_active and not x.is_claimed and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'new_period', (select count(*) from local_businesses x where x.is_active and x.created_at >= t_cur and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'new_prev', (select count(*) from local_businesses x where x.is_active and x.created_at >= t_prev and x.created_at < t_cur and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'claimed_period', (select count(*) from local_businesses x where x.claimed_at >= t_cur and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'claimed_prev', (select count(*) from local_businesses x where x.claimed_at >= t_prev and x.claimed_at < t_cur and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'claims_pending', (select count(*) from business_claims where status = 'pending'),
    'claims_submitted_period', (select count(*) from business_claims where created_at >= t_cur),
    'claims_approved_period', (select count(*) from business_claims where status = 'approved' and reviewed_at >= t_cur),
    'claims_rejected_period', (select count(*) from business_claims where status = 'rejected' and reviewed_at >= t_cur),
    'verified', (select count(*) from local_businesses x where x.is_active and x.is_verified),
    'tiers', coalesce((select jsonb_object_agg(tier, n) from (select coalesce(subscription_tier, 'free') as tier, count(*) as n from local_businesses x where x.is_active and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id) group by 1) z), '{}'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'n', n) order by n desc) from (select coalesce(category, 'uncategorised') as category, count(*) as n from local_businesses x where x.is_active and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id) group by 1 order by 2 desc limit 8) z), '[]'::jsonb),
    'completeness', (select jsonb_build_object(
        'total', count(*),
        'with_description', count(*) filter (where coalesce(length(trim(description)), 0) >= 40),
        'with_logo', count(*) filter (where logo_url is not null),
        'with_cover', count(*) filter (where cover_url is not null),
        'with_contact', count(*) filter (where phone is not null or website is not null or email is not null),
        'with_hours', count(*) filter (where opening_hours is not null),
        'complete_all', count(*) filter (where coalesce(length(trim(description)), 0) >= 40 and logo_url is not null and (phone is not null or website is not null or email is not null)))
        from local_businesses x where x.is_active and x.is_claimed and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'published_by_businesses', jsonb_build_object(
        'events_period', (select count(*) from events where organiser_business_id is not null and created_at >= t_cur),
        'offers_period', (select count(*) from local_offers where created_at >= t_cur),
        'jobs_period', (select count(*) from jobs where posted_as_business_id is not null and created_at >= t_cur),
        'businesses_publishing_60d', (select count(distinct bid) from (
            select organiser_business_id as bid from events where organiser_business_id is not null and created_at > now() - interval '60 days'
            union select business_id from local_offers where created_at > now() - interval '60 days'
            union select posted_as_business_id from jobs where posted_as_business_id is not null and created_at > now() - interval '60 days') u)));

  -- CONTENT
  c := jsonb_build_object(
    'events', jsonb_build_object(
        'upcoming', (select count(*) from events where status = 'published' and not is_hidden and starts_at >= now()),
        'next_14d', (select count(*) from events where status = 'published' and not is_hidden and starts_at >= now() and starts_at < now() + interval '14 days'),
        'new_period', (select count(*) from events where created_at >= t_cur), 'new_prev', (select count(*) from events where created_at >= t_prev and created_at < t_cur),
        'cancelled_upcoming', (select count(*) from events where status in ('cancelled', 'postponed') and starts_at >= now()),
        'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'n', n) order by n desc) from (select coalesce(category, 'other') as category, count(*) as n from events where status = 'published' and not is_hidden and starts_at >= now() group by 1 order by 2 desc limit 8) z), '[]'::jsonb),
        'by_locality', coalesce((select jsonb_agg(jsonb_build_object('locality', loc, 'n', n) order by n desc) from (select coalesce(nullif(trim(locality), ''), 'unspecified') as loc, count(*) as n from events where status = 'published' and not is_hidden and starts_at >= now() group by 1 order by 2 desc limit 8) z), '[]'::jsonb),
        'submissions_pending', (select count(*) from event_submissions where status = 'pending'),
        'submissions_period', (select count(*) from event_submissions where created_at >= t_cur)),
    'activities', jsonb_build_object(
        'published', (select count(*) from regular_activities where status = 'published' and not admin_paused),
        'new_period', (select count(*) from regular_activities where created_at >= t_cur),
        'paused', (select count(*) from regular_activities where admin_paused)),
    'jobs', jsonb_build_object(
        'open', (select count(*) from jobs where status = 'open' and not is_hidden and (expires_at is null or expires_at >= now())),
        'new_period', (select count(*) from jobs where created_at >= t_cur), 'new_prev', (select count(*) from jobs where created_at >= t_prev and created_at < t_cur),
        'closing_7d', (select count(*) from jobs where status = 'open' and not is_hidden and expires_at >= now() and expires_at < now() + interval '7 days'),
        'expired_still_open', (select count(*) from jobs where status = 'open' and not is_hidden and expires_at < now()),
        'applications_period', (select count(*) from job_applications where applied_at >= t_cur),
        'applications_prev', (select count(*) from job_applications where applied_at >= t_prev and applied_at < t_cur)),
    'shifts', jsonb_build_object(
        'open_upcoming', (select count(*) from shifts where status = 'open' and start_at >= now()),
        'new_period', (select count(*) from shifts where created_at >= t_cur),
        'positions_filled', (select coalesce(sum(positions_filled), 0) from shifts where status in ('open', 'filled') and start_at >= t_cur),
        'positions_total', (select coalesce(sum(positions_total), 0) from shifts where status in ('open', 'filled') and start_at >= t_cur)),
    'hubs', jsonb_build_object(
        'active', (select count(*) from hubs x where x.is_active and not exists (select 1 from discovery_fixtures f where f.entity = 'hub' and f.entity_id = x.id)),
        'new_period', (select count(*) from hubs x where x.created_at >= t_cur and not exists (select 1 from discovery_fixtures f where f.entity = 'hub' and f.entity_id = x.id)),
        'publishing_60d', (select count(distinct hid) from (
            select organiser_hub_id as hid from events where organiser_hub_id is not null and created_at > now() - interval '60 days'
            union select publisher_hub_id from notices where publisher_hub_id is not null and created_at > now() - interval '60 days'
            union select organiser_hub_id from regular_activities where organiser_hub_id is not null and updated_at > now() - interval '60 days') u),
        'members', (select count(*) from hub_members where status = 'active')),
    'notices', jsonb_build_object(
        'live', (select count(*) from notices where not is_hidden and (expires_at is null or expires_at >= now())),
        'new_period', (select count(*) from notices where created_at >= t_cur),
        'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'n', n) order by n desc) from (select coalesce(category, 'general') as category, count(*) as n from notices where not is_hidden and (expires_at is null or expires_at >= now()) group by 1 order by 2 desc limit 8) z), '[]'::jsonb)),
    'offers', jsonb_build_object(
        'active', (select count(*) from local_offers where is_active and (valid_until is null or valid_until >= now())),
        'added_period', (select count(*) from local_offers where created_at >= t_cur),
        'expiring_7d', (select count(*) from local_offers where is_active and valid_until >= now() and valid_until < now() + interval '7 days'),
        'redemptions_period', (select count(*) from local_offer_redemptions where redeemed_at >= t_cur),
        'redemptions_prev', (select count(*) from local_offer_redemptions where redeemed_at >= t_prev and redeemed_at < t_cur),
        'businesses_with_active_offer', (select count(distinct business_id) from local_offers where is_active and (valid_until is null or valid_until >= now()))));

  -- MY SAVED: aggregate counts only. No member ids, no per-business saver lists. Jobs live in the older saved_jobs table
  -- (My Saved keeps them there), so both tables are counted.
  s := jsonb_build_object(
    'members_with_saves', (select count(*) from (select user_id from saved_items union select user_id from saved_jobs) z),
    'members_with_2plus', (select count(*) from (select user_id from (select user_id from saved_items union all select user_id from saved_jobs) q group by 1 having count(*) >= 2) z),
    'total_saves', (select count(*) from saved_items) + (select count(*) from saved_jobs),
    'new_saves_period', (select count(*) from saved_items where created_at >= t_cur) + (select count(*) from saved_jobs where created_at >= t_cur),
    'new_saves_prev', (select count(*) from saved_items where created_at >= t_prev and created_at < t_cur) + (select count(*) from saved_jobs where created_at >= t_prev and created_at < t_cur),
    'by_type', coalesce((select jsonb_object_agg(item_type, n) from (
        select item_type, count(*) as n from saved_items group by 1
        union all select 'job', count(*) from saved_jobs having count(*) > 0) z), '{}'::jsonb),
    'adoption_pct', case when n_members > 0 then round(100.0 * (select count(*) from (select user_id from saved_items union select user_id from saved_jobs) z) / n_members, 1) else null end);

  -- COMMERCIAL: counts from business subscription state. Revenue is NOT derived here (see analytics_revenue / Stripe).
  k := jsonb_build_object(
    'paid_active', (select count(*) from local_businesses x where x.subscription_tier in ('pro', 'premium') and x.subscription_until >= now() and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)),
    'paid_by_tier', coalesce((select jsonb_object_agg(subscription_tier, n) from (select subscription_tier, count(*) as n from local_businesses x where x.subscription_tier in ('pro', 'premium') and x.subscription_until >= now() and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id) group by 1) z), '{}'::jsonb),
    'cancelling', (select count(*) from local_businesses x where x.subscription_tier in ('pro', 'premium') and x.subscription_cancel_at_period_end and x.subscription_until >= now()),
    'lapsed_unreconciled', (select count(*) from local_businesses x where x.subscription_tier in ('pro', 'premium') and x.subscription_until < now() - interval '2 days'),
    'claimed_free', (select count(*) from local_businesses x where x.is_active and x.is_claimed and coalesce(x.subscription_tier, 'free') = 'free' and not exists (select 1 from discovery_fixtures f where f.entity = 'business' and f.entity_id = x.id)));

  -- HEALTH
  h := jsonb_build_object(
    'pending_claims', (select count(*) from business_claims where status = 'pending'),
    'pending_event_submissions', (select count(*) from event_submissions where status = 'pending'),
    'open_reports', (select count(*) from content_reports where status in ('open', 'reviewing')),
    'email_sent_period', (select count(*) from email_log where sent_at >= t_cur and status in ('sent', 'delivered')),
    'email_failed_period', (select count(*) from email_log where sent_at >= t_cur and status in ('failed', 'bounced')),
    'push_sent_period', (select count(*) from notification_log where created_at >= t_cur and status = 'sent'),
    'push_errors_period', (select count(*) from notification_log where created_at >= t_cur and status = 'error'),
    'job_sync_last', (select jsonb_build_object('ran_at', ran_at, 'ok', ok, 'reason', reason) from job_sync_runs order by ran_at desc limit 1),
    'job_sync_failed_7d', (select count(*) from job_sync_runs where ran_at >= now() - interval '7 days' and not ok));

  return jsonb_build_object(
    'generated_at', now(), 'days', d, 'period_start', t_cur, 'prev_start', t_prev,
    'members', m, 'engagement', e, 'businesses', b, 'content', c, 'saved', s, 'commercial', k, 'health', h,
    'unavailable', jsonb_build_array(
      'Business profile views per listing in this overview (use per-business analytics)',
      'Subscription upgrades/downgrades over time: the schema stores only the current tier, no subscription history',
      'Business listing last-updated date: local_businesses has no updated_at column, so stale listings cannot be measured',
      'Job apply-started and shift interaction funnels: no events are emitted for these yet',
      'Notification opens: not tracked',
      'Onboarding step completion and drop-off: no onboarding events are emitted (sign_up_completed is registered but never sent)',
      'Revenue and refunds: see the Revenue report (analytics_revenue); not re-derived here'));
end $$;

revoke execute on function public.admin_intel_overview(int) from public, anon;
revoke execute on function public.admin_useful_actions() from public, anon;
revoke execute on function public.admin_action_set_state(text, text, int) from public, anon;
grant execute on function public.admin_intel_overview(int) to authenticated;
grant execute on function public.admin_useful_actions() to authenticated;
grant execute on function public.admin_action_set_state(text, text, int) to authenticated;
