-- Get it done: job enquiries are a Pro/Premium entitlement, enforced in the database.
--  1. create_brief_matches only matches businesses whose Pro (or Premium) entitlement is LIVE right now, using the existing
--     business_meets_tier('pro'): fails closed (unknown business, free tier, expired subscription_until, unknown tier => no match).
--     Premium meets 'pro', so both qualify and there is no ranking difference between them.
--  2. Matches already created are untouched and stay reachable after a plan ends (respond_to_trade_match / get_trade_lead_contact do not
--     check the plan); the gate only stops NEW matches.
--  3. Per-event email dedupe stamps on trade_brief_matches (one email per event per match; set only after a successful send).
--  4. Three transactional email templates (data rows, enabled). No contact details in any of them.
-- Nothing else changes: resident posting, contact sharing and privacy are as before.

alter table public.trade_brief_matches
  add column if not exists lead_email_at timestamptz,        -- trade told a suitable job is waiting
  add column if not exists interest_email_at timestamptz,    -- resident told a business is interested
  add column if not exists share_email_at timestamptz;       -- trade told the resident chose to share details

create or replace function public.create_brief_matches(p_brief uuid, p_business_ids uuid[]) returns uuid[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); b public.trade_briefs; v_ids uuid[];
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into b from public.trade_briefs where id = p_brief and author_id = v_uid and status = 'open' and expires_at > now();
  if not found then raise exception 'No such open job' using errcode = 'P0002'; end if;
  if p_business_ids is null or cardinality(p_business_ids) = 0 then return '{}'; end if;
  with cand as (
    select lb.id, array_position(p_business_ids, lb.id) as pos
    from public.local_businesses lb
    where lb.id = any (p_business_ids)
      and lb.is_active and lb.owner_id is not null and lb.owner_id <> v_uid
      and lb.trade_categories && b.trades
      and coalesce(lb.trade_availability, '') <> 'booked_up'
      and public.business_meets_tier(lb.id, 'pro')                                  -- a LIVE Pro or Premium entitlement, or no match
    order by pos limit 8
  ), ins as (
    insert into public.trade_brief_matches (brief_id, business_id, status)
    select b.id, cand.id, 'sent' from cand
    on conflict (brief_id, business_id) do nothing
    returning business_id
  )
  select coalesce(array_agg(business_id), '{}') into v_ids from ins;
  return v_ids;
end $$;

insert into public.email_templates (key, category, label, description, enabled, subject, body_html, variables, requires_optin, postmark_stream)
values
('trade.lead_waiting', 'business', 'Get it done: a job is waiting', 'Sent to a Pro/Premium business when a suitable job enquiry is matched to it. No customer details.', true,
 'A {{job_type}} job enquiry is waiting for {{business_name}}',
 '<h2>A job enquiry is waiting</h2><p>A suitable job has been matched to {{business_name}}.</p><p><strong>Type of work:</strong> {{job_type}}<br><strong>Area:</strong> {{location}}</p><p>{{summary}}</p><p><a href="{{leads_url}}">Open your job leads</a> to read it and say whether you are interested. The customer''s contact details are not shown. If you say you are interested, the customer chooses whether to share them with you.</p><p>You are getting this because {{business_name}} has job enquiries switched on. OneShetland cannot promise work.</p>',
 array['business_name','job_type','location','summary','leads_url'], false, 'outbound'),
('trade.interest_received', 'business', 'Get it done: a business is interested', 'Sent to the resident when a business says it is interested in their job.', true,
 '{{business_name}} is interested in your job',
 '<h2>A business is interested in your job</h2><p>{{business_name}} has said it is interested in: {{job_title}}.</p><p><a href="{{my_jobs_url}}">Open My jobs</a> to see who they are. Your name and phone number have not been shared. You decide whether to share your contact details with them.</p>',
 array['business_name','job_title','my_jobs_url'], false, 'outbound'),
('trade.details_shared', 'business', 'Get it done: a customer shared their details', 'Sent to a business when the resident chooses to share their contact details. No details in the email.', true,
 'A customer has shared their contact details with {{business_name}}',
 '<h2>A customer has shared their details</h2><p>The customer who posted "{{job_title}}" has chosen to share their contact details with {{business_name}}.</p><p><a href="{{leads_url}}">Open your job leads</a> and sign in to see them. The details are only shown inside your signed-in dashboard.</p>',
 array['business_name','job_title','leads_url'], false, 'outbound')
on conflict (key) do nothing;
