-- ═══════════════════════════════════════════════════════════════════════════
-- email_log / email_templates / email_settings: close anonymous read AND write
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- The baseline created three policies named "Service role full access to ...":
--
--     CREATE POLICY "Service role full access to email_log"       ON public.email_log       USING (true);
--     CREATE POLICY "Service role full access to email_templates" ON public.email_templates USING (true);
--     CREATE POLICY "Service role full access to email_settings"  ON public.email_settings  USING (true);
--
-- None of them said TO service_role. A policy with no role list applies to PUBLIC, so each one was a permissive FOR ALL
-- policy with USING (true) for every role, anon included. The grants (GRANT ALL ... TO anon, authenticated) were also
-- in place, so the public anon key could read and write all three tables over PostgREST:
--
--   email_log        every recipient address, subject, template key and order / event / gift id we have ever mailed
--   email_templates  the body of every transactional email, including account.password_reset ({{reset_url}})
--   email_settings   the sender, reply-to and footer links
--
-- Editing the password-reset template was an account-takeover route: the next genuine reset mail would have carried the
-- recovery link to a destination of the attacker's choosing. Writing to email_log also let an outsider forge or erase the
-- rows request-password-reset counts for its per-address throttle.
--
-- A read-only check of production before this migration found no sign it had been abused: all 42 templates are
-- byte-identical to the repository seeds, the settings are the original values, and the log has no anomalies.
--
-- WHAT THIS DOES — and nothing else
--
--   1. Replaces the three policies with the same-named policy scoped TO service_role. (service_role has BYPASSRLS, so
--      the server-side senders never depended on them; the replacement keeps the documented intent and is inert for
--      every other role.)
--   2. Drops "Users see their own email log". No screen or app reads it (checked: only the two admin Email Centre
--      surfaces touch these tables), and recipient_id is NULL on 156 of 202 rows anyway. Re-add it if a user-facing
--      "my emails" feature is ever built.
--   3. anon loses every privilege on all three tables.
--   4. authenticated loses INSERT / DELETE / TRUNCATE / REFERENCES / TRIGGER on all three, and UPDATE on email_log.
--      SELECT stays on all three and UPDATE stays on templates and settings because the admin Email Centre edits them
--      with the administrator's own session; the existing admin policies ("Admins manage ...", "Admins see all email
--      logs") are what allow a row through, so an ordinary signed-in user still sees and changes nothing.
--
-- NOT TOUCHED: any other table or policy, the admin policies, RLS enablement, service_role's grants, the data.
--
-- THE MIGRATION PROVES ITSELF: it aborts (and rolls back) if, afterwards, any policy on these tables still applies to
-- public / anon / authenticated without an admin test, or if anon still holds any privilege.

begin;

set local lock_timeout = '5s';

-- 1. the three policies, scoped to the role they were always meant for ───────
drop policy if exists "Service role full access to email_log"       on public.email_log;
drop policy if exists "Service role full access to email_templates" on public.email_templates;
drop policy if exists "Service role full access to email_settings"  on public.email_settings;

create policy "Service role full access to email_log"
  on public.email_log       as permissive for all to service_role using (true) with check (true);
create policy "Service role full access to email_templates"
  on public.email_templates as permissive for all to service_role using (true) with check (true);
create policy "Service role full access to email_settings"
  on public.email_settings  as permissive for all to service_role using (true) with check (true);

-- 2. nothing reads the per-user view of the log ───────────────────────────────
drop policy if exists "Users see their own email log" on public.email_log;

-- 3. anon: nothing, on any of the three ───────────────────────────────────────
revoke all on table public.email_log       from public, anon;
revoke all on table public.email_templates from public, anon;
revoke all on table public.email_settings  from public, anon;

-- 4. authenticated: read for the admin policies, edit only where the admin screen edits ─
revoke insert, update, delete, truncate, references, trigger on table public.email_log       from authenticated;
revoke insert,         delete, truncate, references, trigger on table public.email_templates from authenticated;
revoke insert,         delete, truncate, references, trigger on table public.email_settings  from authenticated;

-- 5. self-check: refuse to commit anything that leaves a hole ────────────────
do $check$
declare
  v_bad text;
begin
  select string_agg(format('%s: RLS is not enabled', c.relname), '; ')
    into v_bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('email_log', 'email_templates', 'email_settings')
     and not c.relrowsecurity;
  if v_bad is not null then raise exception 'email tables: %', v_bad; end if;

  -- every remaining policy that can reach a client role must be gated on the administrator check
  select string_agg(format('%s."%s"', p.tablename, p.policyname), ', ')
    into v_bad
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('email_log', 'email_templates', 'email_settings')
     and (p.roles && array['public', 'anon', 'authenticated']::name[])
     and coalesce(p.qual, 'true') !~ 'profiles'
     and coalesce(p.with_check, p.qual, 'true') !~ 'profiles';
  if v_bad is not null then raise exception 'email tables still have an ungated client policy: %', v_bad; end if;

  select string_agg(format('%s %s', g.table_name, g.privilege_type), ', ')
    into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('email_log', 'email_templates', 'email_settings')
     and g.grantee in ('anon', 'PUBLIC');
  if v_bad is not null then raise exception 'anon still holds privileges: %', v_bad; end if;
end
$check$;

commit;
