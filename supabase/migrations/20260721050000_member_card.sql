-- ============================================================================
-- One member card for all of Shetland.
--
-- Instead of a separate stamp card per shop that the customer scans, every
-- member gets ONE permanent code (their member_code). Any taking-part business
-- scans that single code at the till to add a stamp, add points, or redeem a
-- reward — the per-business balances still live in local_loyalty_cards, but the
-- customer only ever shows one code. "One card for every shop in Shetland."
-- ============================================================================

alter table public.profiles
  add column if not exists member_code text unique;

-- Lazily generate (and return) the member code for a user.
create or replace function public.ensure_member_code(p_user uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  select member_code into v_code from public.profiles where id = p_user;
  if v_code is not null then return v_code; end if;
  loop
    -- 8 chars, unambiguous-ish; fine for a QR + occasional manual entry.
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      update public.profiles set member_code = v_code where id = p_user;
      return v_code;
    exception when unique_violation then
      -- clash, try again
    end;
  end loop;
end $$;
grant execute on function public.ensure_member_code(uuid) to authenticated, service_role;
