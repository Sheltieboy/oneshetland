-- Public event listings work again for signed-out visitors.
--
-- WHAT WAS WRONG
--
-- Every anonymous read of public.events failed outright:
--
--     42501: permission denied for table local_businesses
--     hint: Grant the required privileges ... GRANT SELECT ON public.local_businesses TO anon
--
-- Not "no rows" — an ERROR. The website's getUpcomingEvents wraps its query in
-- try/catch and returns [] on failure, so What's On and the Local area quietly
-- showed "no events" while the database was actually refusing the query. Every
-- event was invisible to every signed-out visitor, not just the one reported.
--
-- WHY
--
-- Step 8 removed table-level SELECT on local_businesses from anon and replaced
-- it with column-level grants, deliberately withholding owner_id. But the events
-- RLS policies check ownership by reading that column AS THE CALLER:
--
--     EXISTS (SELECT 1 FROM local_businesses lb
--              WHERE lb.id = events.organiser_business_id
--                AND lb.owner_id = auth.uid())
--
-- A policy is evaluated with the caller's privileges, so anon needed SELECT on
-- local_businesses.owner_id to answer a question whose answer was always going
-- to be "no". authenticated has that column and was unaffected — which is why
-- the app looked fine and only the signed-out website broke.
--
-- THE FIX
--
-- The same shape the hub checks have used all along: ask a SECURITY DEFINER
-- function instead of reading the table. is_hub_admin() and is_hub_member()
-- already sit in these very policies for exactly this reason. The ownership
-- rules are unchanged — only who does the reading changes.
--
-- Granting anon SELECT on owner_id would also have fixed it, and would have
-- undone Step 8 by publishing which user owns which business. Not that.
--
-- SCOPE
--
-- This migration fixes the EVENT journey: public.events and
-- public.event_ticket_types, the two tables the public listing and the event
-- page read (ticket types are an embedded select in the listing query, so they
-- fail the whole request too).
--
-- The same defect affects 26 further tables — local_offers, products,
-- book_services, book_unit_items, business_addons and others all refuse
-- anonymous reads for the same reason. That is a real and separate outage of
-- the signed-out browsing experience, reported rather than bundled into a
-- payment-gate fix, because it needs its own careful pass over ~45 policies.

begin;

-- Does this user own this business? Answered with the function owner's rights,
-- so the caller never needs SELECT on local_businesses.
create or replace function public.is_business_owner(p_business uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.local_businesses b
     where b.id = p_business and b.owner_id = p_user
  );
$$;

-- Does this user own the business organising this event?
create or replace function public.is_event_business_owner(p_event uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.events e
      join public.local_businesses b on b.id = e.organiser_business_id
     where e.id = p_event and b.owner_id = p_user
  );
$$;

-- A NULL user must never match an owner. auth.uid() is NULL for anon, and
-- `owner_id = NULL` is NULL rather than false, so this is stated explicitly.
revoke all on function public.is_business_owner(uuid, uuid)       from public;
revoke all on function public.is_event_business_owner(uuid, uuid) from public;
grant execute on function public.is_business_owner(uuid, uuid)       to anon, authenticated, service_role;
grant execute on function public.is_event_business_owner(uuid, uuid) to anon, authenticated, service_role;

-- ── events ─────────────────────────────────────────────────────────────────
-- Identical rules; the local_businesses subquery is the only thing replaced.
alter policy events_public_read on public.events
  using (
    ((NOT is_hidden) AND ((organiser_hub_id IS NULL) OR (hub_visibility = ANY (ARRAY['hub'::text, 'islands'::text]))))
    OR ((organiser_hub_id IS NOT NULL) AND is_hub_member(organiser_hub_id, auth.uid()))
    OR (organiser_user_id = auth.uid())
    OR public.is_business_owner(organiser_business_id, auth.uid())
    OR ((organiser_hub_id IS NOT NULL) AND is_hub_admin(organiser_hub_id, auth.uid()))
    OR (EXISTS ( SELECT 1 FROM profiles p
                  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))
  );

alter policy events_owner_write on public.events
  using (
    (organiser_user_id = auth.uid())
    OR public.is_business_owner(organiser_business_id, auth.uid())
    OR ((organiser_hub_id IS NOT NULL) AND is_hub_admin(organiser_hub_id, auth.uid()))
    OR (EXISTS ( SELECT 1 FROM profiles p
                  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))
  );

-- ── event_ticket_types ─────────────────────────────────────────────────────
-- The public listing embeds ticket_types, so a refusal here fails the whole
-- request even though the rows themselves are readable by a separate policy.
alter policy ticket_types_owner_all on public.event_ticket_types
  using (
    public.is_event_business_owner(event_id, auth.uid())
    OR (EXISTS ( SELECT 1 FROM events e
                  WHERE ((e.id = event_ticket_types.event_id)
                    AND (e.organiser_hub_id IS NOT NULL)
                    AND is_hub_admin(e.organiser_hub_id, auth.uid()))))
    OR (EXISTS ( SELECT 1 FROM profiles p
                  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))
  );

commit;
