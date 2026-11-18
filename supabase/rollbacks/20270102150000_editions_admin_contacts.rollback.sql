-- Rolls back 20270102150000_editions_admin_contacts.sql. The function holds no data. After this the Editions admin pages cannot show contact emails (the website tolerates that).
drop function if exists public.admin_edition_org_contacts(uuid);
