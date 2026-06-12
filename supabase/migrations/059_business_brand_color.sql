-- 059_business_brand_color.sql
-- Adds a brand_color column to local_businesses. Set automatically from the
-- dominant colour of the uploaded logo, and used to tint the directory banner
-- when the business hasn't uploaded their own cover photo.

alter table public.local_businesses
  add column if not exists brand_color text;

comment on column public.local_businesses.brand_color is
  'Hex colour (#RRGGBB) auto-extracted from the logo; tints the public banner when no cover_url is set.';
