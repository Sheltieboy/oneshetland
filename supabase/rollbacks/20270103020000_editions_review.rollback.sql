-- Rollback of 20270103020000_editions_review. Review history is discarded with its table (the audit log keeps the actions). Editions return to the pre-review public rule.
drop trigger if exists ac_editions_material_change on public.editions;
drop function if exists public.edition_material_change();
CREATE OR REPLACE FUNCTION public.editions_publish_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o public.edition_organisers%rowtype;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    select * into o from public.edition_organisers where id = new.organiser_id;
    if o.status <> 'verified' then raise exception 'organiser is not verified' using errcode = '42501'; end if;
    if not public.edition_entitled(new.id, 'publish') then raise exception 'no live publish entitlement for this edition' using errcode = '42501'; end if;
    if coalesce(btrim(new.summary), '') = '' then raise exception 'a summary is required before publishing' using errcode = '23514'; end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.edition_is_public(p_edition uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.editions e join public.edition_organisers o on o.id = e.organiser_id
     where e.id = p_edition and e.status = 'published' and not e.is_test and not o.is_test and o.status = 'verified'
       and (public.editions_enabled() or public.edition_pilot_visible(o.id))
       and public.edition_entitled(e.id, 'publish'))
$function$;

drop policy if exists "edition_organisers public read" on public.edition_organisers;
create policy "edition_organisers public read" on public.edition_organisers for select to anon, authenticated
  using ((public.editions_enabled() or public.edition_pilot_visible(id)) and status = 'verified' and not is_test);
drop function if exists public.admin_edition_review_detail(uuid);
drop function if exists public.admin_edition_review_counts();
drop function if exists public.admin_edition_review_queue(text);
drop function if exists public.admin_review_edition(uuid, text, text);
drop function if exists public.edition_review_status(uuid);
drop function if exists public.edition_withdraw_submission(uuid);
drop function if exists public.edition_submit_for_review(uuid);
drop function if exists public.edition_readiness(uuid);
drop function if exists public.edition_readiness_items(uuid);
drop function if exists public.edition_my_businesses();
drop table if exists public.edition_reviews;
drop function if exists public.edition_reviews_append_only();
alter table public.editions drop constraint if exists editions_review_state_check;
alter table public.editions drop column if exists approved_at, drop column if exists submitted_at, drop column if exists review_state;
