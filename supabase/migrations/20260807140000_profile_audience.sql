-- Who is this for: someone who lives here, or someone visiting?
--
-- Roughly half of OneShetland is resident utility (Fetch, Shifts, Jobs, the
-- wallet, notices, hubs) and half travels perfectly well to a visitor (What's
-- On, the Directory, Shop Shetland, bookings, Spik, Da Boats, cruise days).
-- A visitor currently lands on a Home ranked for somebody who lives here, so
-- half the screen is spent on things they cannot use.
--
-- This is a RANKING HINT and nothing more. It reorders the For-you feed and
-- the Explore groups; it never hides a section, and nothing reads it for
-- permissions. A Shetlander hosting family and a returning visitor with roots
-- are both real, so nothing may become unreachable because of this column.
--
-- It lives on the profile rather than on the device so it follows the "one
-- login, app and web" promise — set it on the phone, the website honours it.

alter table public.profiles
  add column if not exists audience text not null default 'resident'
    check (audience in ('resident', 'visiting'));

comment on column public.profiles.audience is
  'Ranking hint only: ''resident'' or ''visiting''. Reorders Home; never hides or gates anything.';
