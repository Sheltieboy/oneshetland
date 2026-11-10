-- Read-only post-check for the Editions schema (foundation, final permission model). One row per assertion; every row must say ok = true.
-- Written as rows (not one wide row) so a failing assertion cannot hide in the middle of a line.
select 'every Editions table has RLS on' as check,
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'edition%' and not c.relrowsecurity) = 0 as ok
union all
select 'at least the 14 foundation tables exist',
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'edition%') >= 14
union all
select 'no FOR ALL policy on any Editions table',
       (select count(*) from pg_policies where schemaname = 'public' and tablename like 'edition%' and cmd = 'ALL') = 0
union all
select 'anon has read-only access to Editions tables (no write grant)',
       (select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' and table_name like 'edition%' and privilege_type <> 'SELECT') = 0
union all
-- THE SECURITY ASSERTION. Every Editions function (SECURITY DEFINER or not, whatever its name) that the signed-out role can execute, with its full signature, must be exactly this
-- list. Each is a deliberate public helper: a boolean or constant used by the public RLS policies and views (edition_entitled, edition_is_public, edition_participation_ok,
-- editions_enabled, edition_role_rank, and the three parent-liveness helpers edition_parent_live / edition_business_role / edition_controls_business, which answer only for the caller's own identity or a public fact)
-- or the public membership-tier reader (edition_public_tiers, itself gated on the flag, a verified organiser and a public tier). The pilot reader (edition_pilot_visible) no longer exists.
-- has_function_privilege('anon') includes anything inherited from PUBLIC. A new anon-executable function must be added here deliberately, after review.
select 'the ONLY Editions functions anon can execute are the nine reviewed public helpers',
       coalesce((select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text collate "C")
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and (p.proname ilike '%edition%' or p.proname in ('organiser_memberships_email', 'organisers_audit_status'))
                    and has_function_privilege('anon', p.oid, 'execute')), '')
       = 'edition_business_role(uuid),edition_controls_business(uuid),edition_entitled(uuid,text,timestamp with time zone),edition_is_public(uuid),edition_parent_live(uuid),edition_participation_ok(uuid),edition_public_tiers(text),edition_role_rank(text),editions_enabled()'
union all
select 'no Editions function carries a PUBLIC execute grant or a default ACL',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and (p.proname ilike '%edition%' or p.proname in ('organiser_memberships_email', 'organisers_audit_status'))
           and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) = 0
union all
select 'every anon-executable Editions SECURITY DEFINER function pins its search_path',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname ilike '%edition%' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
           and not coalesce(p.proconfig::text ilike '%search_path%', false)) = 0
union all
select 'the edition-media storage bucket exists (public, 10 MB, images only)',
       (select count(*) from storage.buckets where id = 'edition-media' and public and file_size_limit = 10485760 and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']) = 1
union all
select 'the four edition-media storage policies exist and no other storage policy was touched by name',
       (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'edition-media%') = 4
union all
select 'four reserved names are seeded', (select count(*) from public.edition_reserved_names) = 4
union all
select 'the Editions feature flag is still off (public pages 404, organiser creation limited to administrators)', not public.editions_enabled()
union all
select 'every published real (non-test) Edition has been approved by OneShetland (the publish gate and the public rule both require it; the old pilot exception no longer exists)',
       (select count(*) from public.editions e where e.status = 'published' and not e.is_test and e.review_state <> 'approved') = 0
union all
select 'while Editions is dark, every organiser was created by an administrator (their Hub or Business owner runs it from the parent) and every explicit organiser member is an administrator (no external organiser access)',
       public.editions_enabled() or (
         (select count(*) from public.edition_organisers o where not exists (select 1 from public.profiles p where p.id = o.created_by and p.role = 'admin')) = 0
         and (select count(*) from public.edition_organiser_members m where not exists (select 1 from public.profiles p where p.id = m.user_id and p.role = 'admin')) = 0
         and (select count(*) from public.edition_organiser_invites) = 0);
