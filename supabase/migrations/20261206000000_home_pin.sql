-- Homepage "For you" pinned launch card: admin-managed content, on the EXISTING home_content row.
--
-- WHY HERE. home_content already has the pieces this needs: a one-row table, a public-read policy, an admin-only write policy
-- (is_admin()) and an editor at /admin/homepage. The Notices tables were considered and not used: their public read function
-- (get_public_notices) does not return a pinned flag and there is no admin screen for platform announcements, so reusing them would have meant a
-- new function AND a new editor, and the card would also have appeared in the Notices lists.
--
-- WHAT. Six additive columns, all defaulting to "off / empty": nothing changes on the site until an admin switches the card on.
-- The row is already readable by everyone, which is right: a pinned card is public wording.
-- RULES enforced here as well as in the editor: a card that is switched on must have a title, an expiry date, and a safe link (a site path,
-- or https). Lengths are capped so the card can never overflow its slot.

alter table public.home_content
  add column if not exists pin_enabled boolean not null default false,
  add column if not exists pin_title text,
  add column if not exists pin_body text,
  add column if not exists pin_cta text,
  add column if not exists pin_href text,
  add column if not exists pin_expires_at timestamptz;

alter table public.home_content
  add constraint home_content_pin_lengths check (
    char_length(coalesce(pin_title, '')) <= 60 and char_length(coalesce(pin_body, '')) <= 140
    and char_length(coalesce(pin_cta, '')) <= 24 and char_length(coalesce(pin_href, '')) <= 300),
  add constraint home_content_pin_ready check (
    not pin_enabled or (
      nullif(btrim(coalesce(pin_title, '')), '') is not null
      and pin_expires_at is not null
      and coalesce(pin_href ~ '^(/([^/\s\\<>"''][^\s\\<>"'']*)?|https://[^\s\\<>"'']+)$', false)));   -- coalesce: a missing link must FAIL the check, not slip through as NULL

comment on column public.home_content.pin_enabled is 'Show the pinned card at the head of the homepage For you strip (signed-in members).';
comment on column public.home_content.pin_expires_at is 'Instant after which the card stops showing: the start of the day after the last day the admin chose, Shetland time.';

-- ROLLBACK (run by hand if ever needed; the website ignores the columns if they are absent):
--   alter table public.home_content drop constraint home_content_pin_ready, drop constraint home_content_pin_lengths,
--     drop column pin_enabled, drop column pin_title, drop column pin_body, drop column pin_cta, drop column pin_href, drop column pin_expires_at;
