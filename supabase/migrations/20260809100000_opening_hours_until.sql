-- Opening hours that know when they stop being true.
--
-- Several Shetland attractions publish SUMMER hours with an end date on them:
-- Tangwick Haa closes 30 Sep, Old Haa and the Crofthouse Museum 4 Oct,
-- Quendale Mill 11 Oct. The opening_hours column has no notion of a season, so
-- once those dates pass the planner would still believe the mill opens at ten,
-- send somebody a forty-minute drive to Dunrossness, and give them no "check
-- opening times" warning — because we'd told it we knew.
--
-- That's worse than having no hours at all. Confidently wrong beats honestly
-- unknown only while it stays right.
--
-- After this date the hours are treated as UNKNOWN, not as closed. We know the
-- summer times expired; we don't know what replaced them, and inventing a
-- winter closure would be the same mistake in the other direction.

alter table public.local_businesses
  add column if not exists opening_hours_until date;

comment on column public.local_businesses.opening_hours_until is
  'Last date opening_hours is known to be accurate (seasonal hours). NULL = no known end. Past this date the planner treats the hours as unknown and shows "check opening times" again.';

-- Only the seasonal ones carry a date, so a partial index keeps it small.
create index if not exists local_businesses_hours_until_idx
  on public.local_businesses (opening_hours_until)
  where opening_hours_until is not null;
