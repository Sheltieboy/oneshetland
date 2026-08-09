-- Fix: "infinite recursion detected in policy for relation trade_briefs".
--
-- The two policies referenced each other. Reading a brief checked
-- trade_brief_matches ("was this sent to a business I own?"), and reading a
-- match checked trade_briefs ("am I the author?"). Each check triggered the
-- other table's policy, which triggered the first again, and Postgres stopped
-- it the only way it can.
--
-- Both tables were unreadable — every select returned the recursion error, so
-- nothing worked at all rather than working insecurely. It surfaced the moment
-- the migration was run and the tables were queried.
--
-- The fix is the standard one: move each cross-table check into a SECURITY
-- DEFINER function. Those run as the owner and so don't re-enter RLS, which
-- breaks the loop. They're deliberately narrow — each answers exactly one
-- yes/no question about the caller and nothing else, and neither can be used
-- to read a row.

create or replace function public.can_see_brief(p_brief_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.trade_brief_matches m
    join public.local_businesses b on b.id = m.business_id
    where m.brief_id = p_brief_id
      and b.owner_id = auth.uid()
  );
$$;

comment on function public.can_see_brief is
  'Was this brief sent to a business the caller owns? SECURITY DEFINER so the RLS check does not re-enter trade_brief_matches'' own policy.';

create or replace function public.is_brief_author(p_brief_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trade_briefs b
    where b.id = p_brief_id and b.author_id = auth.uid()
  );
$$;

comment on function public.is_brief_author is
  'Does the caller own this brief? SECURITY DEFINER for the same reason as can_see_brief.';

grant execute on function public.can_see_brief(uuid)   to authenticated;
grant execute on function public.is_brief_author(uuid) to authenticated;

-- Rebuild only the two policies that crossed over. The author's own policy on
-- trade_briefs and the trade's own policy on trade_brief_matches never
-- referenced the other table, so they were never part of the loop.

drop policy if exists "trade reads briefs sent to it" on public.trade_briefs;
create policy "trade reads briefs sent to it" on public.trade_briefs
  for select using (public.can_see_brief(id));

drop policy if exists "author reads own matches" on public.trade_brief_matches;
create policy "author reads own matches" on public.trade_brief_matches
  for select using (public.is_brief_author(brief_id));
