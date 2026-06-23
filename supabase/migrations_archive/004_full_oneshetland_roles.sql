-- Migration 004: Extend profiles for full OneShetland platform
-- Supabase is now the single source of truth for all OneShetland users.
-- WordPress auth is dropped. All apps use this profiles table.

-- Extend the role enum to cover all OneShetland roles
-- (Supabase uses text columns, not enums, so we update the check constraint)
alter table profiles
  drop constraint if exists profiles_role_check;

alter table profiles
  add constraint profiles_role_check
    check (role in (
      'customer',       -- default: can request deliveries, use all OneShetland features
      'driver',         -- approved delivery driver
      'business_owner', -- lists a business/service in the directory
      'employer',       -- posts jobs on the jobs board
      'contributor',    -- can submit events, notices etc (trusted community member)
      'moderator',      -- can approve/reject submitted content
      'admin'           -- full platform access
    ));

-- Add profile fields useful across all OneShetland features
alter table profiles
  add column if not exists avatar_url     text,
  add column if not exists display_name   text,   -- shown publicly; defaults to full_name
  add column if not exists bio            text,   -- short bio for business owners / contributors
  add column if not exists website_url    text,
  add column if not exists location_area  text,   -- e.g. "Lerwick", "Yell" — chosen from regions
  add column if not exists email_verified boolean not null default false,
  add column if not exists is_active      boolean not null default true;  -- soft-delete / suspend

-- Index for quick lookups by role (e.g. find all moderators)
create index if not exists profiles_role_idx on profiles (role);

-- Note: run this in the Supabase SQL Editor for the nkrtmakxygkvxuxriiil project
