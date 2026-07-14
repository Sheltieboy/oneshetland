-- Let an employer see WHO applied to their shifts/jobs — but only safe, public
-- fields (name, avatar, area), never phone / Stripe / push-token / role.
--
-- The employer applicant view previously read public.profiles directly, but the
-- only SELECT policies on profiles are "own profile" and "admin", so an employer
-- got NOTHING back and every applicant showed as "Unknown". This SECURITY DEFINER
-- function returns just the display fields, and only for workers who actually
-- applied to a shift or job the caller posted.

create or replace function public.get_applicant_public(p_worker_ids uuid[])
returns table (
  id uuid,
  display_name text,
  full_name text,
  avatar_url text,
  location_area text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name, p.full_name, p.avatar_url, p.location_area, p.created_at
  from public.profiles p
  where p.id = any (p_worker_ids)
    and (
      exists (
        select 1 from public.shift_applications sa
        join public.shifts s on s.id = sa.shift_id
        where sa.worker_id = p.id and s.employer_id = auth.uid()
      )
      or exists (
        select 1 from public.job_applications ja
        join public.jobs j on j.id = ja.job_id
        where ja.applicant_id = p.id and j.employer_id = auth.uid()
      )
    );
$$;

grant execute on function public.get_applicant_public(uuid[]) to authenticated;
