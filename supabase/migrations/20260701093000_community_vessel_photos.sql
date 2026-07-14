-- ============================================================================
-- Community vessel photos → moderated gallery
--
-- Problem: a photo posted in a vessel's DISCUSSION lands in
-- vessel_comments.image_url and never reaches the boat's PHOTO GALLERY. The
-- gallery is built from media_assets + vessel_media_links, and INSERT on those
-- (plus source_documents) is admin/moderator-only via the "da_boats admin
-- write" RLS policies. media_assets.source_document_id is also NOT NULL. So a
-- normal signed-in user cannot contribute a gallery photo today.
--
-- This migration lets an authenticated user submit a vessel photo that is held
-- PENDING (invisible to the public) until an admin/moderator approves it. On
-- approval it becomes an ordinary gallery item.
--
-- Design:
--   1. A stable "community-uploads" source_documents row so community media has
--      a valid source_document_id without needing admin INSERT rights.
--   2. A moderation column set on media_assets: approval_status
--      (pending/approved/rejected, default 'pending') + submitted_by,
--      reviewed_by, reviewed_at, approved_at. All existing rows are backfilled
--      to 'approved' so the curated archive stays visible exactly as before.
--   3. RLS so authenticated users may INSERT one media_asset + one
--      vessel_media_link ONLY as pending, ONLY against the community source,
--      ONLY with submitted_by = auth.uid(). Public/anon SELECT of gallery media
--      is narrowed to approved-only (submitters still see their own pending
--      row; admins/moderators see everything). Admin/moderator UPDATE flips the
--      status. Existing admin-curated write/update/delete/read policies are
--      untouched.
--
-- NON-DESTRUCTIVE + REVERSIBLE. Adds columns/policies/one seed row only; no
-- drops of data, no column type changes. A down-migration is sketched at the
-- foot of the file (commented) for reference.
-- ============================================================================

begin;

-- ── 1. Community source document ────────────────────────────────────────────
-- Stable, known id so the app/web can reference it without a lookup round-trip.
-- ON CONFLICT keeps this idempotent and non-destructive if re-run.
insert into public.source_documents (id, slug, title, source_type, publisher, notes)
values (
  '00000000-0000-4000-8000-0000000da404',
  'community-uploads',
  'Community uploads',
  'community',
  'OneShetland community',
  'Umbrella source for photos contributed by signed-in users via a vessel discussion. Each media_asset carries its own submitted_by + moderation status.'
)
on conflict (id) do nothing;

-- If a row with that slug already exists under a different id, leave it — the
-- unique(slug) constraint guarantees at most one, and the app resolves by slug
-- as a fallback (see COMMUNITY_SOURCE_SLUG in the client).
insert into public.source_documents (slug, title, source_type, publisher, notes)
values (
  'community-uploads',
  'Community uploads',
  'community',
  'OneShetland community',
  'Umbrella source for community-contributed vessel photos.'
)
on conflict (slug) do nothing;

-- ── 2. Moderation columns on media_assets ───────────────────────────────────
alter table public.media_assets
  add column if not exists approval_status text not null default 'pending',
  add column if not exists submitted_by    uuid,
  add column if not exists reviewed_by     uuid,
  add column if not exists reviewed_at     timestamptz,
  add column if not exists approved_at     timestamptz;

-- Value guard. Added NOT VALID then validated so a re-run on a table with data
-- can't spuriously fail; the backfill below satisfies it either way.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'media_assets_approval_status_check'
  ) then
    alter table public.media_assets
      add constraint media_assets_approval_status_check
      check (approval_status in ('pending','approved','rejected')) not valid;
  end if;
end$$;

-- Backfill: every pre-existing (admin-curated) asset is already-approved so the
-- new approved-only public read does not hide the historical archive. Because
-- the column defaults to 'pending', we flip existing rows explicitly. New rows
-- inserted after this migration default to 'pending' as intended.
update public.media_assets
   set approval_status = 'approved',
       approved_at     = coalesce(approved_at, created_at)
 where approval_status <> 'approved'
   and submitted_by is null;   -- only the legacy/curated rows; leave any pending community rows alone

alter table public.media_assets validate constraint media_assets_approval_status_check;

-- FKs for the moderation actor columns (SET NULL so deleting a profile never
-- orphans an asset). Guarded so the migration is idempotent.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'media_assets_submitted_by_fkey') then
    alter table public.media_assets
      add constraint media_assets_submitted_by_fkey
      foreign key (submitted_by) references public.profiles(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'media_assets_reviewed_by_fkey') then
    alter table public.media_assets
      add constraint media_assets_reviewed_by_fkey
      foreign key (reviewed_by) references public.profiles(id) on delete set null;
  end if;
end$$;

create index if not exists idx_media_assets_pending
  on public.media_assets (approval_status, created_at)
  where approval_status = 'pending';

create index if not exists idx_media_assets_submitted_by
  on public.media_assets (submitted_by)
  where submitted_by is not null;

-- ── 3. Boats-moderator helper ───────────────────────────────────────────────
-- The "da_boats admin write/update/delete" policies gate on role in
-- ('admin','moderator'). is_admin() only covers 'admin' (+platform owner), so we
-- add a dedicated helper that matches the da_boats convention, keeping the new
-- policies consistent with the existing curation policies on these tables.
create or replace function public.is_boats_moderator()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role in ('admin','moderator') or p.is_platform_owner = true)
  );
$$;

-- ── 4. RLS: community submissions to media_assets ───────────────────────────
-- The community source id, repeated in the WITH CHECK so a submission cannot be
-- attached to any other (curated) source document.
--   community source id = 00000000-0000-4000-8000-0000000da404

-- Authenticated users may INSERT a media_asset ONLY as a pending community
-- submission owned by themselves. Existing "da_boats admin write" stays as-is
-- for full curation.
drop policy if exists "community media submit" on public.media_assets;
create policy "community media submit"
  on public.media_assets
  for insert
  to authenticated
  with check (
    submitted_by = auth.uid()
    and approval_status = 'pending'
    and source_document_id = '00000000-0000-4000-8000-0000000da404'::uuid
    and asset_type = 'photo'
  );

-- Narrow the public read from USING(true) to approved-only, while keeping
-- pending rows visible to their submitter and to moderators. Existing admin
-- curation SELECT is subsumed by is_boats_moderator().
drop policy if exists "da_boats public read" on public.media_assets;
create policy "da_boats public read"
  on public.media_assets
  for select
  using (
    approval_status = 'approved'
    or submitted_by = auth.uid()
    or public.is_boats_moderator()
  );

-- Moderators approve/reject. (Curated "da_boats admin update" already exists and
-- is left in place; this adds nothing that conflicts — Postgres RLS is a union
-- of permissive policies, so either policy passing is enough.)
drop policy if exists "community media moderate" on public.media_assets;
create policy "community media moderate"
  on public.media_assets
  for update
  to authenticated
  using (public.is_boats_moderator())
  with check (public.is_boats_moderator());

-- ── 5. RLS: community submissions to vessel_media_links ─────────────────────
-- Authenticated users may link ONLY a media_asset they submitted, that is still
-- pending, and only as a low-confidence community link. The EXISTS sub-select
-- proves ownership of the target asset.
drop policy if exists "community media link" on public.vessel_media_links;
create policy "community media link"
  on public.vessel_media_links
  for insert
  to authenticated
  with check (
    confidence = 'possible'
    and exists (
      select 1 from public.media_assets m
      where m.id = media_asset_id
        and m.submitted_by = auth.uid()
        and m.approval_status = 'pending'
        and m.source_document_id = '00000000-0000-4000-8000-0000000da404'::uuid
    )
  );

-- vessel_media_links public read stays USING(true): a link to a pending asset
-- is harmless because the joined media_assets row is filtered out by the read
-- policy above (the client drops links whose media is null). No change needed.

commit;

-- ============================================================================
-- DOWN (reference only — do not run as part of this migration):
--
--   begin;
--   drop policy if exists "community media link"     on public.vessel_media_links;
--   drop policy if exists "community media moderate" on public.media_assets;
--   drop policy if exists "community media submit"   on public.media_assets;
--   -- restore the original permissive public read
--   drop policy if exists "da_boats public read"     on public.media_assets;
--   create policy "da_boats public read" on public.media_assets for select using (true);
--   drop function if exists public.is_boats_moderator();
--   drop index if exists public.idx_media_assets_pending;
--   drop index if exists public.idx_media_assets_submitted_by;
--   alter table public.media_assets
--     drop constraint if exists media_assets_approval_status_check,
--     drop constraint if exists media_assets_submitted_by_fkey,
--     drop constraint if exists media_assets_reviewed_by_fkey,
--     drop column if exists approval_status,
--     drop column if exists submitted_by,
--     drop column if exists reviewed_by,
--     drop column if exists reviewed_at,
--     drop column if exists approved_at;
--   delete from public.source_documents where slug = 'community-uploads';
--   commit;
-- ============================================================================
