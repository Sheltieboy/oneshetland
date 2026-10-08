-- A claim decision should always say who made it and when. approve_business_claim records both, but a REJECTION
-- is a plain UPDATE from the admin screens: the web screen sets neither field and the app sets only the time, so
-- rejected claims had no reviewer on record. Fill them in at the door, for both clients, with no app change.
-- Only when a pending claim becomes approved or rejected; an explicit value from the caller is kept.

create or replace function public.business_claims_record_decider()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    new.reviewed_at := coalesce(new.reviewed_at, now());
    new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
  end if;
  return new;
end;
$$;

revoke execute on function public.business_claims_record_decider() from public, anon, authenticated;

drop trigger if exists business_claims_record_decider on public.business_claims;
create trigger business_claims_record_decider
  before update on public.business_claims
  for each row execute function public.business_claims_record_decider();
