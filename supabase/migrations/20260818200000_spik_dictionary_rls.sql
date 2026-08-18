-- ============================================================================
-- spik_dictionary is the last table in public without RLS — Supabase's advisor
-- has been flagging it as rls_disabled_in_public since 17 Aug 2026. With RLS
-- off, the anon key can not only read the dictionary but UPDATE and DELETE it.
-- The whole Spik corpus, the Wirdil hint columns and the contributor credits
-- are one anonymous request away from being wiped.
--
-- Reads are genuinely public and the product depends on it: the A-Z browse and
-- search in the app (lib/oneshetland-api.ts), the word pages and sitemap on the
-- web, the social-image card, and the social-composer / reminder-runner edge
-- functions — none of which use the service role, so they read as anon and must
-- keep working.
--
-- So: reads stay exactly as wide as they are today, writes stop dead. No
-- insert/update/delete policy is created, which leaves the service role (it
-- bypasses RLS) and the dashboard as the only ways in — matching how the
-- dictionary is actually maintained, since no client code writes to it.
--
-- Deliberately NOT filtering reads by word_status. Some callers already limit
-- themselves to approved/published, but the A-Z browse does not, so a policy
-- restricting it would quietly empty parts of the dictionary. Whether drafts
-- should be public is a separate decision, not one to smuggle into a security
-- fix.
-- ============================================================================

alter table public.spik_dictionary enable row level security;

drop policy if exists "spik dictionary public read" on public.spik_dictionary;
create policy "spik dictionary public read" on public.spik_dictionary
  for select to anon, authenticated using (true);
