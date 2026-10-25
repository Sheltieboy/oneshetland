-- shift_employer_profiles.stripe_customer_id is a server-side Stripe detail. It was readable by anyone holding the public
-- anon key and writable by every signed-in user, because the baseline gave anon and authenticated table-level SELECT / INSERT /
-- UPDATE and the "employer profile visible to all" policy (USING true) lets every row through.
--
-- Nothing uses the column: no client selects it, no Edge Function or SQL function reads it, and production holds no value in it.
-- Stripe customers are bound server-side (_shared/stripe-customer.ts) from profiles / local_businesses, not from here.
--
-- A column privilege cannot be taken away while a table-level privilege covers it, so SELECT / INSERT / UPDATE are withdrawn at
-- table level from the two client roles and granted back on every column except the protected one. Row-level security, the
-- column itself (type, default, nullability), its data, DELETE and every other privilege are untouched. service_role keeps its
-- table-level grant, so every server path still reads and writes the whole row.
--
-- Fail-closed by design: a column added to this table later is NOT reachable by clients until it is granted here explicitly.

begin;

revoke select, insert, update on table public.shift_employer_profiles from anon, authenticated;

grant select (id, business_name, description, logo_url, website, is_verified, rating_avg, rating_count, created_at, updated_at)
  on public.shift_employer_profiles to anon, authenticated;
grant insert (id, business_name, description, logo_url, website, is_verified, rating_avg, rating_count, created_at, updated_at)
  on public.shift_employer_profiles to anon, authenticated;
grant update (id, business_name, description, logo_url, website, is_verified, rating_avg, rating_count, created_at, updated_at)
  on public.shift_employer_profiles to anon, authenticated;

comment on column public.shift_employer_profiles.stripe_customer_id is
  'Server-side Stripe customer id. No client privilege (anon / authenticated): revoked 20261122000000. Do not grant it back.';

-- Prove the end state inside the same transaction; any surprise rolls the whole migration back.
do $$
declare
  r text; a text; c text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach a in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(r, 'public.shift_employer_profiles', 'stripe_customer_id', a) then
        raise exception 'shift_employer_profiles.stripe_customer_id still has % for %', a, r;
      end if;
      foreach c in array array['id', 'business_name', 'description', 'logo_url', 'website', 'is_verified', 'rating_avg', 'rating_count', 'created_at', 'updated_at'] loop
        if not has_column_privilege(r, 'public.shift_employer_profiles', c, a) then
          raise exception 'shift_employer_profiles.% lost % for %', c, a, r;
        end if;
      end loop;
    end loop;
  end loop;
  foreach a in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.shift_employer_profiles', 'stripe_customer_id', a) then
      raise exception 'service_role lost % on shift_employer_profiles.stripe_customer_id', a;
    end if;
  end loop;
end $$;

commit;
