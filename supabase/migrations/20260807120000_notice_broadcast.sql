-- Community-wide urgent notices: record when one has been broadcast.
--
-- Business alerts reach a business's own loyalty customers. There has been no
-- way to reach EVERYONE — the road's shut, the ferry's off, the water's not
-- safe to drink. This column is what makes that send safe to expose: the
-- broadcast function refuses to fire twice for the same notice, so a
-- double-tap (or a retried request) can't push the whole island twice.
--
-- Deliberately a timestamp, not a boolean: knowing WHEN it went matters when
-- someone asks why they got it at 3am.

alter table public.notices
  add column if not exists broadcast_at timestamptz,
  add column if not exists broadcast_by uuid references public.profiles(id);

comment on column public.notices.broadcast_at is
  'When this notice was pushed island-wide. Set only by the notify-community-notice edge function; its presence blocks a second send.';

-- Finding the unsent urgent ones is the only query that matters here.
create index if not exists notices_urgent_unbroadcast_idx
  on public.notices (published_at desc)
  where severity = 'urgent' and broadcast_at is null;
