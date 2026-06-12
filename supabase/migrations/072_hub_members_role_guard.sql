-- 072_hub_members_role_guard.sql
-- SECURITY: lock down hub_members role/status changes.
--
-- The "hub_members update" policy allows a user to update their OWN row (so they
-- can leave). With no column restriction, a regular member could PATCH their own
-- row to role='committee' (self-promotion to admin) or status='active'
-- (self-approval). This trigger enforces, for user-initiated updates:
--   • role may only be changed by the HUB OWNER (or platform admin)
--   • status may only be set to 'active' by a hub admin (owner/committee) —
--     i.e. members can leave, but can't approve themselves.
-- Service-role / SECURITY DEFINER paths (edge functions, the membership
-- activation RPC) have a NULL auth.uid() and are unaffected.

create or replace function public.tg_hub_members_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_owner    boolean;
  v_is_admin    boolean;
  v_is_platform boolean;
begin
  -- Service role / server context: no user JWT → trust it.
  if auth.uid() is null then
    return new;
  end if;

  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    into v_is_platform;
  if v_is_platform then
    return new;
  end if;

  select coalesce(bool_or(h.owner_id = auth.uid()), false) into v_is_owner
    from public.hubs h where h.id = new.hub_id;
  v_is_admin := public.is_hub_admin(new.hub_id, auth.uid());

  -- Role changes are owner-only.
  if new.role is distinct from old.role and not v_is_owner then
    new.role := old.role;
  end if;

  -- Only hub admins can activate a membership (approve). Members can leave.
  if new.status is distinct from old.status
     and new.status = 'active' and not v_is_admin then
    new.status := old.status;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_hub_members_guard on public.hub_members;
create trigger trg_hub_members_guard
  before update on public.hub_members
  for each row execute function public.tg_hub_members_guard();
