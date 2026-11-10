-- Editions admin: let platform administrators read an organiser's contact email THROUGH an admin-only function.
--
-- Problem (found on production 10 Nov 2026): the Editions admin pages (Verification queue, Organisers, organiser detail) select edition_organisers.contact_email
-- directly. That column is deliberately NOT readable by the authenticated role (migration 20270102080000 / 110000: contact details are private to the organiser team,
-- through edition_org_contact_email), so every such query fails with "permission denied for table edition_organisers", administrators included.
--
-- Fix, keeping the model strict: nothing about the table grants changes. Administrators get the same read the other internal columns already have
-- (admin_edition_org_internal, admin_edition_org_flags): a SECURITY DEFINER function that refuses everyone who is not a platform administrator.
-- Additive: one function. No table, column, policy or grant is changed.

create or replace function public.admin_edition_org_contacts(p_org uuid default null)
returns table (id uuid, contact_email text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select o.id, o.contact_email from public.edition_organisers o where p_org is null or o.id = p_org;
end $$;

revoke all on function public.admin_edition_org_contacts(uuid) from public, anon, authenticated;
grant execute on function public.admin_edition_org_contacts(uuid) to authenticated;
