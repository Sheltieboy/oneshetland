-- ============================================================================
-- Anonymous writes get refused by their own policy, not by an error about
-- somebody else's table.
--
-- WHAT THE LIVE PROBE SHOWED
--
-- Posting an object to /storage/v1/object/avatars/... with only the public anon
-- key came back:
--
--   {"statusCode":"403","error":"Unauthorized",
--    "message":"permission denied for table local_businesses"}
--
-- The upload was refused, which is right, but not for the reason it looks like.
-- Every INSERT policy on storage.objects is evaluated and OR'd, so an upload to
-- ANY bucket also evaluates the business-media policy, and that reads
-- public.local_businesses. Step 8 removed table-wide SELECT there and granted
-- columns instead, giving `owner_id` to authenticated only — so for anon the
-- subquery raises instead of returning false.
--
-- Three things wrong with leaning on that:
--
--   * it is an accident. The request is refused because a different bucket's
--     policy cannot run, not because the caller failed the check that applies
--     to them. Change an unrelated grant and the behaviour changes with it.
--   * it names an internal table to an anonymous caller.
--   * it makes every anon refusal identical regardless of bucket, which hides
--     whatever the real policy would have said.
--
-- THE FIX IS TO SAY WHO THE POLICIES ARE FOR
--
-- Writing to storage requires auth.uid() in every one of these policies
-- already, so no policy loses anything by being scoped to `authenticated`.
-- What changes is that an anonymous request never evaluates them at all: it is
-- refused because no write policy applies to its role, which is exactly the
-- true reason.
--
-- SELECT stays on `public`. These buckets are deliberately world-readable and
-- their objects are served to anonymous visitors by design.
-- ============================================================================

do $$
declare
  b     text;
  buckets text[] := array['avatars','boat-comment-media','business-media','cruise-media',
                          'employer-logos','event-media','hub-media','memories-media',
                          'site-media','spik-audio'];
  p     record;
begin
  foreach b in array buckets loop
    -- Re-scope every write policy this project owns for this bucket, keeping
    -- its expression exactly as it is and changing only the role it applies to.
    for p in
      select policyname, cmd, qual, with_check
        from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname like b || ' %'
         and cmd in ('INSERT','UPDATE','DELETE')
    loop
      execute format('drop policy if exists %I on storage.objects', p.policyname);

      if p.cmd = 'INSERT' then
        execute format('create policy %I on storage.objects for insert to authenticated with check (%s)',
                       p.policyname, p.with_check);
      elsif p.cmd = 'UPDATE' then
        if p.with_check is null then
          execute format('create policy %I on storage.objects for update to authenticated using (%s)',
                         p.policyname, p.qual);
        else
          execute format('create policy %I on storage.objects for update to authenticated using (%s) with check (%s)',
                         p.policyname, p.qual, p.with_check);
        end if;
      else
        execute format('create policy %I on storage.objects for delete to authenticated using (%s)',
                       p.policyname, p.qual);
      end if;
    end loop;
  end loop;
end $$;

-- Guard: no write policy this project owns may still be open to the public role.
do $$
declare v_bad text;
begin
  select string_agg(policyname || ' [' || cmd || ']', ', ') into v_bad
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and cmd in ('INSERT','UPDATE','DELETE')
     and roles::text like '%public%'
     and (policyname like 'avatars %' or policyname like 'boat-comment-media %'
       or policyname like 'business-media %' or policyname like 'cruise-media %'
       or policyname like 'employer-logos %' or policyname like 'event-media %'
       or policyname like 'hub-media %' or policyname like 'memories-media %'
       or policyname like 'site-media %' or policyname like 'spik-audio %');
  if v_bad is not null then
    raise exception 'write policies still granted to public: %', v_bad;
  end if;
end $$;
