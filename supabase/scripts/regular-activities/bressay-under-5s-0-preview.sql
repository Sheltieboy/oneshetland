-- Bressay Under 5s -> Regular Activity: READ-ONLY PREVIEW. Changes nothing. Works before the Regular Activities migration is applied.
-- It lists the seven event rows (named by id; nothing is matched by title), the weekly rule they imply, and which row is an exception.
with src(ord, id) as (values
  (1,'631c1981-5ddc-834d-9456-1e62a30ce691'::uuid),(2,'28a12d8c-c8be-7398-884a-c0f56842a890'),(3,'82b66785-b681-99b2-16d9-c8643feaaf2e'),
  (4,'03d78c64-c673-b340-8785-b5e2db410511'),(5,'45d1ba64-f991-6414-4e41-d61318ee8144'),(6,'00c6df8c-41cc-62d0-6204-a2d91de09229'),
  (7,'a2e870ef-c163-bc6b-fb4a-7daf1bbde8c5'))
select s.ord,
       s.id as event_id,
       to_char(e.starts_at at time zone 'Europe/London', 'Dy DD Mon YYYY HH24:MI') as now_listed_as,
       to_char(e.ends_at   at time zone 'Europe/London', 'HH24:MI') as ends,
       e.status, e.is_platform_event as platform_owned, e.venue,
       (extract(dow from e.starts_at at time zone 'Europe/London') = 5
        and (e.starts_at at time zone 'Europe/London')::time = time '10:30'
        and (e.ends_at   at time zone 'Europe/London')::time = time '12:30') as fits_weekly_rule,
       case when extract(dow from e.starts_at at time zone 'Europe/London') = 5 and (e.starts_at at time zone 'Europe/London')::time = time '10:30'
            then 'regular Friday session'
            else 'EXCEPTION: scheduled Fri ' || to_char((e.starts_at at time zone 'Europe/London')::date - 1, 'DD Mon') || ' 10:30, moved to ' || to_char(e.starts_at at time zone 'Europe/London', 'Dy DD Mon HH24:MI') end as becomes
  from src s join public.events e on e.id = s.id
 order by s.ord;
