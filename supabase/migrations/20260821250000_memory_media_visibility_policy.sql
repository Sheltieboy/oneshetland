-- ============================================================================
-- PHASE 1 of the memory-media cutover: teach storage the visibility rule.
-- The bucket stays PUBLIC here on purpose.
--
-- WHAT IS WRONG TODAY
--
-- public.memories supports public / community / private and its own RLS
-- enforces that properly. memories-media does not: its SELECT policy is
-- `bucket_id = 'memories-media'` and the bucket's public flag serves objects
-- straight out, so possession of the /object/public/… URL bypasses the model
-- entirely. Every memory is currently public, so nothing is exposed — but the
-- first private one would be.
--
-- ONE RULE, NOT TWO
--
-- The obvious fix is to restate the visibility rule inside the storage policy:
-- not hidden AND (public OR (community AND signed in) OR author OR moderator).
-- That is a second copy of a security decision, and copies drift.
--
-- Instead can_view_memory() asks the question the database already answers:
--
--   select exists (select 1 from public.memories m where m.id = p_memory)
--
-- SECURITY INVOKER, so it runs as the caller and the memories RLS policy does
-- the deciding. Whatever that policy says today, and whatever it is changed to
-- tomorrow, storage follows automatically. There is no second definition of
-- "private" to keep in step.
--
-- It is deliberately NOT security definer. A definer function here would have
-- to re-implement the rule (its own RLS would be bypassed), which is precisely
-- the duplication being avoided — and it would be a privileged function
-- answering questions about other people's data. Invoker needs no elevated
-- grant at all: it can see exactly what its caller can see, which is the whole
-- point. It returns a boolean and never data.
--
-- WHY THE BUCKET IS STILL PUBLIC AFTER THIS MIGRATION
--
-- Public delivery ignores RLS, so this policy changes nothing on its own. It
-- exists so that createSignedUrl() starts working under the correct rule while
-- the old public URLs keep the live site rendering. The flag flips in a later
-- migration, once both clients are deployed and resolving media by signed URL.
-- Flipping it now would break oneshetland.com/memories before the website could
-- catch up.
-- ============================================================================

create or replace function public.can_view_memory(p_memory uuid)
returns boolean
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select exists (select 1 from public.memories m where m.id = p_memory);
$$;

comment on function public.can_view_memory(uuid) is
  'Whether the CALLER may see this memory. SECURITY INVOKER on purpose: it asks public.memories under the caller''s own RLS, so the visibility rule lives in exactly one place and storage follows it automatically. Returns a boolean, never data.';

-- No grant is needed beyond the default: the function is not privileged and
-- reveals nothing its caller could not already select. The usual PUBLIC EXECUTE
-- default is correct here for the first time in this codebase, and is stated
-- rather than left to look like an oversight.


-- ── The memory-aware read policy ────────────────────────────────────────────
--
-- Path convention, confirmed against all 17 live objects and both clients:
--   <memory_id>/<kind>/<file>
-- so the parent memory is the first path segment.
--
-- Objects whose first segment is not a memory — there are 7, abandoned composer
-- uploads that never got a memory_media row — resolve to false and become
-- unreadable. They are left in place rather than deleted; nothing references
-- them and this migration does not remove media.
drop policy if exists "memories-media public read" on storage.objects;

create policy "memories-media visibility read" on storage.objects
  for select using (
    bucket_id = 'memories-media'
    and public.can_view_memory((storage.foldername(objects.name))[1]::uuid));


do $$
declare v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname='storage' and tablename='objects'
     and policyname = 'memories-media visibility read';
  if v_n <> 1 then
    raise exception 'the memory-aware read policy was not installed';
  end if;

  if exists (select 1 from pg_policies
              where schemaname='storage' and tablename='objects'
                and policyname = 'memories-media public read') then
    raise exception 'the old unconditional read policy is still present';
  end if;
end $$;
