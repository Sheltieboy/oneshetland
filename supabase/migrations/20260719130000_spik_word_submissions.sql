-- Spik: let the community SUBMIT A WHOLE NEW WORD (not just edit fields of an
-- existing one). Submissions land here as 'pending'; an admin approves them in
-- Control Centre, which publishes the word live to spik_dictionary via
-- approve_spik_word_submission(). Mirrors the existing spik_suggestions +
-- approve_spik_suggestion() pattern (is_admin() guard, SECURITY DEFINER).

create table if not exists public.spik_word_submissions (
  id                 uuid primary key default gen_random_uuid(),
  word               text not null,
  alternate_spelling text,
  pronunciation      text,
  short_meaning      text,
  spik_meaning       text,
  example_sentence   text,
  part_of_speech     text,
  category           text,
  usage_level        text,
  era                text,
  tone               text,
  origin             text,
  notes              text,
  submitter_id       uuid references auth.users(id) on delete set null,
  submitter_name     text,
  show_name          boolean not null default true,
  status             text not null default 'pending' check (status in ('pending','approved','rejected')),
  published_word_id  integer,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists spik_word_submissions_pending_idx
  on public.spik_word_submissions (created_at desc) where status = 'pending';

alter table public.spik_word_submissions enable row level security;

-- Anyone (signed in or not) may submit a new word.
drop policy if exists "anyone can submit a word" on public.spik_word_submissions;
create policy "anyone can submit a word" on public.spik_word_submissions
  for insert to anon, authenticated with check (true);

-- Admins can read + triage (mirrors spik_suggestions admin RLS).
drop policy if exists "admins read word submissions" on public.spik_word_submissions;
create policy "admins read word submissions" on public.spik_word_submissions
  for select to authenticated using (public.is_admin());

drop policy if exists "admins update word submissions" on public.spik_word_submissions;
create policy "admins update word submissions" on public.spik_word_submissions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Approve & publish: insert the submission into the live dictionary, credit the
-- submitter (if they chose to be shown), and mark it approved. Admin-only.
-- spik_dictionary.id is a plain integer (WordPress import, no sequence), so we
-- compute the next id. first_letter is stored LOWERCASE — the A–Z browse query
-- filters on lower(first_letter).
create or replace function public.approve_spik_word_submission(p_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s      public.spik_word_submissions%rowtype;
  new_id integer;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;

  select * into s from public.spik_word_submissions where id = p_id;
  if not found then raise exception 'Submission not found'; end if;
  if s.status = 'approved' then return s.published_word_id; end if;

  select coalesce(max(id), 0) + 1 into new_id from public.spik_dictionary;

  insert into public.spik_dictionary (
    id, word, first_letter, alternate_spelling, pronunciation, short_meaning,
    spik_meaning, example_sentence, part_of_speech, category, usage_level, era,
    tone, origin, notes, contributor_name, contributor_show, updated_at
  ) values (
    new_id, s.word, lower(left(s.word, 1)), s.alternate_spelling, s.pronunciation, s.short_meaning,
    s.spik_meaning, s.example_sentence, s.part_of_speech, s.category, s.usage_level, s.era,
    s.tone, s.origin, s.notes,
    case when s.show_name then s.submitter_name else null end,
    coalesce(s.show_name, true), now()
  );

  update public.spik_word_submissions
     set status = 'approved', reviewed_at = now(), published_word_id = new_id
   where id = p_id;

  return new_id;
end;
$$;

grant execute on function public.approve_spik_word_submission(uuid) to authenticated;
