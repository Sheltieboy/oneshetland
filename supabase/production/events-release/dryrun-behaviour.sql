insert into dr(k,v) select 'pre.tests.notification_log', count(*)::text from public.notification_log;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$insert into public.events (title,starts_at,status,is_platform_event) values ('DRYRUN',now()+interval '40 days','published',false)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t01.member_insert_event', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$insert into public.event_occurrences (event_id,starts_at) values ('@@PLAIN_PLATFORM_EVENT_ID@@','2026-12-27 19:00:00+00')$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t02.member_insert_occurrence', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$insert into public.event_occurrences (event_id,starts_at,ends_at) values ('@@PLAIN_PLATFORM_EVENT_ID@@','2026-12-27 19:00:00+00','2026-12-27 22:00:00+00'),('@@PLAIN_PLATFORM_EVENT_ID@@','2026-12-28 19:00:00+00',null)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t03.staff_adds_two_dates', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select is_dated_run::text||'|'||(starts_at='2026-12-27 19:00:00+00')::text||'|'||(ends_at='2026-12-28 19:00:00+00')::text from public.events where id='@@PLAIN_PLATFORM_EVENT_ID@@'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t03b.parent_synced', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.event_occurrences where event_id='@@PLAIN_PLATFORM_EVENT_ID@@'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t04.anon_reads_occurrences', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$insert into public.event_ticket_types (event_id,name,price_pence) values ('@@PLAIN_PLATFORM_EVENT_ID@@','DRY',100)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t05.ticket_type_on_run_refused', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$update public.event_occurrences set status='cancelled' where event_id='@@PLAIN_PLATFORM_EVENT_ID@@' and starts_at='2026-12-28 19:00:00+00'$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t06a.cancel_one', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select is_dated_run::text||'|'||(starts_at='2026-12-27 19:00:00+00')::text||'|'||(ends_at='2026-12-27 22:00:00+00')::text from public.events where id='@@PLAIN_PLATFORM_EVENT_ID@@'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t06b.parent_after_cancel', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$insert into public.event_ticket_types (event_id,name,price_pence,quantity_available) values ('@@PLAIN_PLATFORM_EVENT_ID@@','DRY',100,5)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t06c.type_allowed_with_one_live', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$update public.event_occurrences set status='scheduled' where event_id='@@PLAIN_PLATFORM_EVENT_ID@@' and status='cancelled'$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t06d.reactivating_date_blocked_when_ticketed', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$set local session_replication_role = replica; update public.event_occurrences set status='scheduled' where event_id='@@PLAIN_PLATFORM_EVENT_ID@@'; set local session_replication_role = origin$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t07a.force_run', coalesce(r,'(null)'));
end $do$;
insert into dr_vars(k,v) select 'run_tt', id::text from public.event_ticket_types where event_id='@@PLAIN_PLATFORM_EVENT_ID@@' limit 1;
do $do$ declare r text; tt text; begin select v into tt from dr_vars where k='run_tt'; perform set_config('request.jwt.claims','{"sub":"","role":"service_role"}',true); set local role service_role; begin perform public.reserve_ticket_basket('@@PLAIN_PLATFORM_EVENT_ID@@','@@MEMBER_ID@@', jsonb_build_array(jsonb_build_object('ticket_type_id',tt,'token_hash','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),100,0,'{}'::jsonb,'req-dryrun-run-1'); r:='SOLD (bad)'; exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end; reset role; insert into dr(k,v) values ('t07b.reserve_on_run_refused', r); end $do$;
do $do$ declare r text; begin 
  begin execute $q$insert into public.events (id,title,starts_at,ends_at,status,is_platform_event) values ('dddddddd-0000-4000-8000-000000000001','DRYRUN ticketed',now()+interval '90 days',now()+interval '90 days 3 hours','published',true); insert into public.event_ticket_types (id,event_id,name,price_pence,quantity_available,per_order_max,is_active) values ('dddddddd-0000-4000-8000-000000000002','dddddddd-0000-4000-8000-000000000001','Adult',100,5,5,true)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t08a.make_synthetic_event', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "service_role"}',true); perform set_config('request.jwt.claim.sub','',true); set local role service_role;
  begin execute $q$select (select public.reserve_ticket_basket('dddddddd-0000-4000-8000-000000000001','@@MEMBER_ID@@',$j$[{"ticket_type_id": "dddddddd-0000-4000-8000-000000000002", "token_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]$j$::jsonb,100,0,'{}'::jsonb,'req-dryrun-sale-1'))->>'order_id'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t08b.sale', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$update public.event_ticket_orders set status='paid', paid_at=now(), stripe_payment_intent_id='pi_dryrun_1' where event_id='dddddddd-0000-4000-8000-000000000001'; update public.event_tickets set status='valid' where event_id='dddddddd-0000-4000-8000-000000000001'; select public.increment_event_tickets_sold('dddddddd-0000-4000-8000-000000000001',1)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t08c.pay', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "service_role"}',true); perform set_config('request.jwt.claim.sub','',true); set local role service_role;
  begin execute $q$select (select public.reserve_ticket_basket('dddddddd-0000-4000-8000-000000000001','@@MEMBER_ID@@',$j$[{"ticket_type_id": "dddddddd-0000-4000-8000-000000000002", "token_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]$j$::jsonb,100,0,'{}'::jsonb,'req-dryrun-sale-1'))->>'already'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t08d.retry_is_idempotent', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select quantity_sold::text from public.event_ticket_types where id='dddddddd-0000-4000-8000-000000000002'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t08e.sold_before_refund', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select public.refund_event_tickets_for_payment('pi_dryrun_1', true)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t08f.real_refund', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select (select quantity_sold from public.event_ticket_types where id='dddddddd-0000-4000-8000-000000000002')::text||'|'||(select status from public.event_ticket_orders where stripe_payment_intent_id='pi_dryrun_1')||'|'||(select count(*) from public.event_tickets where event_id='dddddddd-0000-4000-8000-000000000001' and status='valid')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t08g.after_refund', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "service_role"}',true); perform set_config('request.jwt.claim.sub','',true); set local role service_role;
  begin execute $q$select left((select public.reserve_ticket_basket('@@TICKETED_EVENT_ID@@','@@MEMBER_ID@@',$j$[{"ticket_type_id": "@@TICKET_TYPE_ID@@", "token_hash": "cccccccccccccccccccccccccccccccccccccccc"}]$j$::jsonb,100,0,'{}'::jsonb,'req-dryrun-real-1'))::text,60)$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t09.reserve_on_real_ticketed_event_info', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.submit_event_submission($j${"request_id": "00000000-0000-4000-8000-0000000000a1", "organiser_name": "Dry Run Players", "title": "Dry Run Panto", "description": "An evening of songs and sketches in the village hall.", "category": "theatre_performing_arts", "venue": "Town Hall", "locality": "Lerwick", "price_text": "Free", "contact_info": "dryrun@example.org", "ticket_url": null, "cover_url": null, "adult_confirmed": true, "occurrences": [{"starts_at": "2027-01-06 19:00:00+00"}, {"starts_at": "2027-01-07 19:00:00+00"}, {"starts_at": "2027-01-08 14:00:00+00"}]}$j$::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t10.closed_member_refused', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$select public.submit_event_submission($j${"request_id": "00000000-0000-4000-8000-0000000000a2", "organiser_name": "Dry Run Players", "title": "Dry Run Staff", "description": "An evening of songs and sketches in the village hall.", "category": "theatre_performing_arts", "venue": "Town Hall", "locality": "Lerwick", "price_text": "Free", "contact_info": "dryrun@example.org", "ticket_url": null, "cover_url": null, "adult_confirmed": true, "occurrences": [{"starts_at": "2027-01-06 19:00:00+00"}, {"starts_at": "2027-01-07 19:00:00+00"}, {"starts_at": "2027-01-08 14:00:00+00"}]}$j$::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t11.closed_staff_allowed', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$insert into public.admin_config (key,value,category) values ('events.member_submissions','open','events')$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t12.open_switch', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.submit_event_submission($j${"request_id": "00000000-0000-4000-8000-0000000000a3", "organiser_name": "Dry Run Players", "title": "Dry Run Panto", "description": "An evening of songs and sketches in the village hall.", "category": "theatre_performing_arts", "venue": "Town Hall", "locality": "Lerwick", "price_text": "Free", "contact_info": "dryrun@example.org", "ticket_url": null, "cover_url": null, "adult_confirmed": true, "occurrences": [{"starts_at": "2027-01-06 19:00:00+00"}, {"starts_at": "2027-01-07 19:00:00+00"}, {"starts_at": "2027-01-08 14:00:00+00"}]}$j$::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t13.member_submits', coalesce(r,'(null)'));
end $do$;
insert into dr_vars(k,v) select 'sid', (select v from dr where k='t13.member_submits' limit 1);
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.submit_event_submission($j${"request_id": "00000000-0000-4000-8000-0000000000a4", "organiser_name": "Dry Run Players", "title": "Past", "description": "An evening of songs and sketches in the village hall.", "category": "theatre_performing_arts", "venue": "Town Hall", "locality": "Lerwick", "price_text": "Free", "contact_info": "dryrun@example.org", "ticket_url": null, "cover_url": null, "adult_confirmed": true, "occurrences": [{"starts_at": "2026-11-04 19:00:00+00"}]}$j$::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t13b.past_date_refused', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.submit_event_submission($j${"request_id": "00000000-0000-4000-8000-0000000000a5", "organiser_name": "Dry Run Players", "title": "Link", "description": "Tickets at http://spam.example.com now", "category": "theatre_performing_arts", "venue": "Town Hall", "locality": "Lerwick", "price_text": "Free", "contact_info": "dryrun@example.org", "ticket_url": null, "cover_url": null, "adult_confirmed": true, "occurrences": [{"starts_at": "2027-01-06 19:00:00+00"}, {"starts_at": "2027-01-07 19:00:00+00"}, {"starts_at": "2027-01-08 14:00:00+00"}]}$j$::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t13c.link_in_description_refused', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_review_event_submission((select v from dr_vars where k='sid')::uuid,'approve',null)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t13d.member_cannot_approve', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_review_event_submission((select v from dr_vars where k='sid')::uuid,'approve',null)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t14.staff_approves', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_review_event_submission((select v from dr_vars where k='sid')::uuid,'approve',null)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t14b.approve_twice_idempotent', coalesce(r,'(null)'));
end $do$;
insert into dr_vars(k,v) select 'ev', event_id::text from public.event_submissions where id=(select v from dr_vars where k='sid')::uuid;
do $do$ declare r text; begin 
  begin execute $q$select (is_platform_event and source='community_submission' and organiser_name='Dry Run Players' and is_dated_run and status='published' and organiser_business_id is null and organiser_hub_id is null)::text||'|'||(select count(*) from public.event_occurrences where event_id=e.id)::text||'|'||(select count(*) from public.events where source is null)::text from public.events e where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t15.community_event_shape', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select count(*)::text from public.events where submission_id=(select v from dr_vars where k='sid')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t15b.one_event_per_submission', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t16.anon_sees_community_event', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select (source is not null and organiser_name is not null)::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t16b.community_event_not_hidden_official', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.report_performance_cancelled((select id from public.event_occurrences where event_id=(select v from dr_vars where k='ev')::uuid order by starts_at limit 1),'dry run')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t17.contributor_cancels_performance', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select (starts_at='2027-01-07 19:00:00+00')::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t17b.parent_moved_to_next_live', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@BUSINESS_OWNER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@BUSINESS_OWNER_ID@@',true); set local role authenticated;
  begin execute $q$select public.report_event_cancelled((select v from dr_vars where k='ev')::uuid,'x')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t18.other_user_refused', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$update public.events set title='hijack' where id=(select v from dr_vars where k='ev')::uuid; select 1$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t18b.member_cannot_edit_event_directly', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select title from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t18c.title_unchanged', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.request_event_change((select v from dr_vars where k='ev')::uuid,$j${"title":"Dry Run Panto (new title)"}$j$::jsonb,'00000000-0000-4000-8000-0000000000b1')->>'status'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t19.change_request_pending', coalesce(r,'(null)'));
end $do$;
insert into dr_vars(k,v) select 'cr', id::text from public.event_change_requests where event_id=(select v from dr_vars where k='ev')::uuid limit 1;
do $do$ declare r text; begin 
  begin execute $q$select title from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t19b.title_not_yet_changed', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_review_event_change((select v from dr_vars where k='cr')::uuid,'approve',null)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t20.staff_approves_change', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select title from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t20b.title_changed', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.request_event_change((select v from dr_vars where k='ev')::uuid,$j${"description":"Updated description for the show."}$j$::jsonb,'00000000-0000-4000-8000-0000000000b2')->>'status'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t21a.untrusted_description_pending', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_set_organiser_trust('@@MEMBER_ID@@',true,'x')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t21b.member_cannot_self_trust', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_set_organiser_trust('@@MEMBER_ID@@',true,'dry run')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t21c.staff_grants_trust', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.request_event_change((select v from dr_vars where k='ev')::uuid,$j${"description":"A different, longer description of the show."}$j$::jsonb,'00000000-0000-4000-8000-0000000000b3')->>'status'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t21d.trusted_description_auto_applies', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.report_event_cancelled((select v from dr_vars where k='ev')::uuid,'dry run')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27a.contributor_cancels_whole_event', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27b.anon_opens_cancelled_page_by_link', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid and status='published'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27c.published_list_leaves_it_out', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid and not is_hidden$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27d.is_hidden_list_leaves_it_out', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.event_occurrences where event_id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27e.anon_sees_its_dates', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.events where status='published' and not is_hidden$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27f.anon_event_count_unchanged_vs_pre_listing', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$update public.events set status='draft' where id=(select v from dr_vars where k='ev')::uuid$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t27g.draft_stays_hidden', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27h.anon_draft_hidden', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$update public.events set status='postponed' where id=(select v from dr_vars where k='ev')::uuid$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t27i.postponed_contributor_still_reads', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27j.contributor_reads_postponed', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@BUSINESS_OWNER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@BUSINESS_OWNER_ID@@',true); set local role authenticated;
  begin execute $q$select count(*)::text from public.events where id=(select v from dr_vars where k='ev')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t27k.other_user_cannot_read_postponed', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.submit_event_submission($j${"request_id": "00000000-0000-4000-8000-0000000000a9", "organiser_name": "Dry Run Players", "title": "Dry Run Two", "description": "An evening of songs and sketches in the village hall.", "category": "theatre_performing_arts", "venue": "Town Hall", "locality": "Lerwick", "price_text": "Free", "contact_info": "dryrun@example.org", "ticket_url": null, "cover_url": null, "adult_confirmed": true, "occurrences": [{"starts_at": "2027-01-16 19:00:00+00"}]}$j$::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t28a.second_submission', coalesce(r,'(null)'));
end $do$;
insert into dr_vars(k,v) select 'sid2', (select v from dr where k='t28a.second_submission' limit 1);
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@ADMIN_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@ADMIN_ID@@',true); set local role authenticated;
  begin execute $q$select public.admin_review_event_submission((select v from dr_vars where k='sid2')::uuid,'approve',null)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t28b.approve_second', coalesce(r,'(null)'));
end $do$;
insert into dr_vars(k,v) select 'ev2', event_id::text from public.event_submissions where id=(select v from dr_vars where k='sid2')::uuid;
do $do$ declare r text; begin 
  begin execute $q$insert into public.event_ticket_types (id,event_id,name,price_pence,quantity_available,per_order_max,is_active) values ('dddddddd-0000-4000-8000-000000000012',(select v from dr_vars where k='ev2')::uuid,'Adult',100,5,5,true)$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t28c.staff_adds_ticket_type', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "service_role"}',true); perform set_config('request.jwt.claim.sub','',true); set local role service_role;
  begin execute $q$select (public.reserve_ticket_basket((select v from dr_vars where k='ev2')::uuid,'@@MEMBER_ID@@',jsonb_build_array(jsonb_build_object('ticket_type_id','dddddddd-0000-4000-8000-000000000012','token_hash','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')),100,0,'{}'::jsonb,'req-dryrun-buyer-1'))->>'order_id'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t28d.buyer_reserves', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.report_event_cancelled((select v from dr_vars where k='ev2')::uuid,'x')::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t28e.contributor_cancel_refused_with_buyers', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select status from public.events where id=(select v from dr_vars where k='ev2')::uuid$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t28f.event_still_published', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$insert into public.events (title,starts_at,status,is_platform_event,organiser_business_id,source) values ('x',now()+interval '30 days','draft',false,'@@BUSINESS_ID@@','oneshetland')$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t29a.marker_refused_on_business_event', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$insert into public.events (title,starts_at,status,is_platform_event,source) values ('DRYRUN marked',now()+interval '30 days','draft',true,'oneshetland')$q$; r:='OK';
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t29b.marker_allowed_on_platform_event', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select count(*)::text from public.events where source is not null and submission_id is null and title not like 'DRYRUN%'$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t29c.existing_events_still_unmarked', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@MEMBER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@MEMBER_ID@@',true); set local role authenticated;
  begin execute $q$select public.my_event_organiser_trusted()::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t30a.trusted_function_true_for_trusted', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "@@BUSINESS_OWNER_ID@@", "role": "authenticated"}',true); perform set_config('request.jwt.claim.sub','@@BUSINESS_OWNER_ID@@',true); set local role authenticated;
  begin execute $q$select public.my_event_organiser_trusted()::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t30b.trusted_function_false_for_other', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select ((select count(*) from public.notification_log)-(select v from dr where k='pre.tests.notification_log')::bigint)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t22.no_notifications_written', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select public.submit_event_submission('{}'::jsonb)::text$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t23.anon_cannot_submit', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin perform set_config('request.jwt.claims','{"sub": "00000000-0000-0000-0000-000000000000", "role": "anon"}',true); perform set_config('request.jwt.claim.sub','',true); set local role anon;
  begin execute $q$select count(*)::text from public.event_submissions$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  reset role;
  insert into dr(k,v) values ('t24.anon_cannot_read_submissions', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select coalesce((select value from public.admin_config where key='fetch.operations'),'(absent)')$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t25.fetch_still_paused', coalesce(r,'(null)'));
end $do$;
do $do$ declare r text; begin 
  begin execute $q$select count(*)::text from public.activity_sessions(now(), now() + interval '14 days')$q$ into r;
  exception when others then r:='ERR '||sqlstate||': '||left(sqlerrm,110); end;
  
  insert into dr(k,v) values ('t26.activities_unchanged', coalesce(r,'(null)'));
end $do$;
