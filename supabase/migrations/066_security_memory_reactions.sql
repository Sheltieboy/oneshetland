-- 066_security_memory_reactions.sql
-- SECURITY (privacy): tighten memory_reactions read access.
--
-- The original policy was `USING (auth.uid() IS NOT NULL)` — ANY signed-in user
-- could read EVERY reaction by EVERY user on EVERY memory, including reactions on
-- private/hidden memories, which leaks participation patterns.
--
-- New rule: you can read a reaction only if it's YOURS, or it's on a memory you
-- are actually allowed to see. The EXISTS subquery against `memories` is itself
-- evaluated under the memories table's RLS for the calling user, so it
-- transparently reuses the existing memory-visibility rules — no duplication.
--
-- Non-breaking: the app reads reactions only for a memory it's already viewing
-- (aggregate counts) or filtered to the user's own rows; both paths still pass.

drop policy if exists "memory_reactions read" on public.memory_reactions;

create policy "memory_reactions read"
  on public.memory_reactions for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.memories m
      where m.id = memory_reactions.memory_id
    )
  );
