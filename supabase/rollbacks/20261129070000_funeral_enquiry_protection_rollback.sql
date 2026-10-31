-- Rollback of 20261129070000_funeral_enquiry_protection: restores the previous (INSECURE) behaviour — anyone may call the function, with the shared quotas.
-- Only use it together with rolling the website back to the page that calls PostgREST directly.
begin;
delete from public.rate_limit_policies where action in ('funeral_enquiry_ip_attempt','funeral_enquiry_ip_hour','funeral_enquiry_ip_day','funeral_enquiry_ip_announcement','funeral_enquiry_announcement','funeral_enquiry_global');
create or replace function public.submit_funeral_enquiry(p_id uuid, p_kind text, p_message text, p_contact text, p_contact_name text default null, p_relationship text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
begin
  if p_kind not in ('correction', 'takedown', 'enquiry') then raise exception 'Unknown request' using errcode = '22023'; end if;
  if p_message is null or length(btrim(p_message)) < 5 or length(btrim(p_message)) > 1000 then raise exception 'Please say what you need (5 to 1000 characters)' using errcode = '22023'; end if;
  if v_contact is null or length(v_contact) < 5 or length(v_contact) > 200 then raise exception 'Please give a telephone number or email address so we can reach you' using errcode = '22023'; end if;
  if length(coalesce(p_contact_name, '')) > 120 or length(coalesce(p_relationship, '')) > 120 then raise exception 'Too long' using errcode = '22023'; end if;
  if not exists (select 1 from public.funeral_notices where id = p_id and status = 'approved' and display_until > now()) then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  if (select count(*) from public.funeral_change_requests where funeral_id = p_id and source = 'public' and created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.funeral_change_requests where source = 'public' and lower(contact) = lower(v_contact) and created_at > now() - interval '24 hours') >= 3
     or (select count(*) from public.funeral_change_requests where source = 'public' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many requests. Please try again later or call us' using errcode = '54000';
  end if;
  insert into public.funeral_change_requests (funeral_id, kind, source, contact_name, relationship, contact, message)
  values (p_id, p_kind, 'public', nullif(btrim(coalesce(p_contact_name, '')), ''), nullif(btrim(coalesce(p_relationship, '')), ''), v_contact, btrim(p_message)) returning id into v_id;
  perform public.notice_audit('funeral_enquiry_received', null, null, p_id, jsonb_build_object('kind', p_kind, 'source', 'public'));
  return v_id;
end $$;
grant execute on function public.submit_funeral_enquiry(uuid, text, text, text, text, text) to anon, authenticated;
commit;
