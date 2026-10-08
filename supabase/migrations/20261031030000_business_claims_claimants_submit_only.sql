-- A business claim is a request that an ADMIN decides. The policy "Users manage their own claims" was FOR ALL,
-- so the claimant could also change or delete their own request after submitting it:
--
--   · swap business_id after the admin had read the claim, so approve_business_claim (which reads the row at the
--     moment of approval) hands over a different, more valuable, listing than the one the admin was shown;
--   · mark their own claim 'approved', or write reviewed_by / admin_note, forging the review record;
--   · delete the claim and its history.
--
-- Nothing in the apps needs any of that: a claimant only ever INSERTS a pending claim and READS their own
-- (submitBusinessClaim / fetchMyClaim, and the web claim form, which sends status 'pending'). So a claimant may
-- now submit a pending, unreviewed claim and read their own, and nothing else. Admin review (the "Admins read
-- all claims" and "Admins update claims" policies and the approve_business_claim function) is untouched.
--
-- Also caps open requests per person: signing up is free and there are ~530 unclaimed listings, so without a cap
-- one account could queue hundreds of claims and bury the admin queue and the admin alerts.

drop policy if exists "Users manage their own claims" on public.business_claims;
drop policy if exists "Users read their own claims" on public.business_claims;
drop policy if exists "Users submit their own pending claims" on public.business_claims;

create policy "Users read their own claims" on public.business_claims
  for select using (user_id = auth.uid());

create policy "Users submit their own pending claims" on public.business_claims
  for insert with check (
    user_id = auth.uid()
    and status = 'pending'
    and reviewed_at is null
    and reviewed_by is null
    and admin_note is null
  );

create or replace function public.business_claims_cap_open()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.business_claims where user_id = new.user_id and status = 'pending') >= 5 then
    raise exception 'You already have 5 claims waiting for review. Please wait for a decision before claiming more.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.business_claims_cap_open() from public, anon, authenticated;

drop trigger if exists business_claims_cap_open on public.business_claims;
create trigger business_claims_cap_open
  before insert on public.business_claims
  for each row when (new.status = 'pending')
  execute function public.business_claims_cap_open();
