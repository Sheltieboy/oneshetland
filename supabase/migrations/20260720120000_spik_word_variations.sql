-- Spik: LOCAL VARIATIONS + contributor audio.
-- A single word can be spelled/said differently across Shetland (Burra vs
-- Whalsay, etc.). Each variation lives here, tied to a region and the signed-in
-- contributor who added it, and carries up to two audio clips — one of them
-- saying the word, one of them saying an example sentence. Variations land as
-- 'pending' and an admin approves them in Control Centre (mirrors the
-- spik_suggestions / spik_word_submissions moderation pattern: is_admin() guard,
-- SECURITY DEFINER approve RPC). Approved variations render on the word page
-- grouped by region.

create table if not exists public.spik_word_variations (
  id                 uuid primary key default gen_random_uuid(),
  word_id            integer not null references public.spik_dictionary(id) on delete cascade,
  region_id          uuid references public.regions(id) on delete set null,
  region_name        text not null,               -- snapshot label (region may be renamed/removed)
  variant_spelling   text,                          -- how the word is spelled in that region
  pronunciation      text,                          -- how it sounds, written (e.g. AHB-er)
  word_audio_url     text,                          -- them saying the word
  sentence_text      text,                          -- an example sentence
  sentence_audio_url text,                          -- them saying that sentence
  contributor_id     uuid not null references auth.users(id) on delete cascade,
  contributor_name   text,
  show_name          boolean not null default true,
  status             text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists spik_word_variations_word_idx
  on public.spik_word_variations (word_id) where status = 'approved';
create index if not exists spik_word_variations_pending_idx
  on public.spik_word_variations (created_at desc) where status = 'pending';

alter table public.spik_word_variations enable row level security;

-- Anyone may read APPROVED variations (they show on the public word page).
drop policy if exists "read approved variations" on public.spik_word_variations;
create policy "read approved variations" on public.spik_word_variations
  for select to anon, authenticated using (status = 'approved');

-- A signed-in contributor may read their own (any status) + add new ones as
-- themselves. Adding a variation requires being signed in (contributor_id must
-- equal the caller) — no anonymous audio.
drop policy if exists "read own variations" on public.spik_word_variations;
create policy "read own variations" on public.spik_word_variations
  for select to authenticated using (contributor_id = auth.uid());

drop policy if exists "contributors add variations" on public.spik_word_variations;
create policy "contributors add variations" on public.spik_word_variations
  for insert to authenticated with check (contributor_id = auth.uid() and status = 'pending');

-- Admins can read + triage everything.
drop policy if exists "admins read variations" on public.spik_word_variations;
create policy "admins read variations" on public.spik_word_variations
  for select to authenticated using (public.is_admin());

drop policy if exists "admins update variations" on public.spik_word_variations;
create policy "admins update variations" on public.spik_word_variations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── Storage bucket for contributor audio (public read, signed-in write) ────────
-- Clips are small; cap objects at 10 MB and accept common browser/phone formats.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'spik-audio', 'spik-audio', true, 10485760,
  array['audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a','audio/mp3']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "spik-audio public read" on storage.objects;
create policy "spik-audio public read" on storage.objects
  for select using (bucket_id = 'spik-audio');

-- Any signed-in user may upload their pronunciation clips.
drop policy if exists "spik-audio signed-in write" on storage.objects;
create policy "spik-audio signed-in write" on storage.objects
  for insert to authenticated with check (bucket_id = 'spik-audio');

drop policy if exists "spik-audio admin delete" on storage.objects;
create policy "spik-audio admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'spik-audio' and public.is_admin());

-- Approve a variation: just flip it live. Unlike word submissions there's
-- nothing to copy into spik_dictionary — approved variations render straight
-- from this table. Admin-only.
create or replace function public.approve_spik_word_variation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  update public.spik_word_variations
     set status = 'approved', reviewed_at = now()
   where id = p_id;
end;
$$;

grant execute on function public.approve_spik_word_variation(uuid) to authenticated;
