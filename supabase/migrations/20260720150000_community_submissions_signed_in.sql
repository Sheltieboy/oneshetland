-- Community submissions (new Spik words + new Da Boats hulls) require sign-in.
-- Tightens the insert policies so only an authenticated user submitting as
-- themselves can add a row — no anonymous submissions. Reliable attribution +
-- less junk to moderate. (Spik local variations were already signed-in only.)

-- Spik: new-word submissions.
drop policy if exists "anyone can submit a word" on public.spik_word_submissions;
drop policy if exists "signed-in can submit a word" on public.spik_word_submissions;
create policy "signed-in can submit a word" on public.spik_word_submissions
  for insert to authenticated with check (submitter_id = auth.uid());

-- Da Boats: new-boat (hull) submissions.
drop policy if exists "anyone can submit a vessel" on public.vessel_submissions;
drop policy if exists "signed-in can submit a vessel" on public.vessel_submissions;
create policy "signed-in can submit a vessel" on public.vessel_submissions
  for insert to authenticated with check (submitter_id = auth.uid());
