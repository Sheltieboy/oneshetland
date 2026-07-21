-- ============================================================================
-- Referrals — "refer a friend, you both get a reward".
--
-- Each member has a short referral_code. A new member applies a friend's code;
-- when that new member makes their first real wallet spend (≥ £3), BOTH wallets
-- are credited £5 automatically. All state changes happen server-side (SECURITY
-- DEFINER RPC + a DB trigger) so clients can't self-award.
-- ============================================================================

alter table public.profiles
  add column if not exists referral_code text unique;

create table if not exists public.referrals (
  id                    uuid primary key default gen_random_uuid(),
  referrer_id           uuid not null references public.profiles(id) on delete cascade,
  referee_id            uuid not null references public.profiles(id) on delete cascade,
  code                  text not null,
  status                text not null default 'pending' check (status in ('pending','rewarded','void')),
  referrer_reward_pence integer not null default 500,
  referee_reward_pence  integer not null default 500,
  rewarded_at           timestamptz,
  created_at            timestamptz not null default now(),
  unique (referee_id)   -- a member can only ever be referred once
);
create index if not exists referrals_referrer_idx on public.referrals(referrer_id);

alter table public.referrals enable row level security;

-- Both parties can read referrals they're part of; nobody writes directly.
drop policy if exists "see own referrals" on public.referrals;
create policy "see own referrals" on public.referrals
  for select using (referrer_id = auth.uid() or referee_id = auth.uid());

-- ── Lazily generate (and return) the caller-visible code for a member. ────────
create or replace function public.ensure_referral_code(p_user uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  select referral_code into v_code from public.profiles where id = p_user;
  if v_code is not null then return v_code; end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    begin
      update public.profiles set referral_code = v_code where id = p_user;
      return v_code;
    exception when unique_violation then
      -- code clash — loop and try another
    end;
  end loop;
end $$;
grant execute on function public.ensure_referral_code(uuid) to authenticated, service_role;

-- ── Apply a friend's code (the referee calls this). ──────────────────────────
create or replace function public.apply_referral_code(p_code text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare v_referrer uuid; v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'auth required'; end if;
  if p_code is null or length(trim(p_code)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Enter a code');
  end if;
  select id into v_referrer from public.profiles where referral_code = upper(trim(p_code));
  if v_referrer is null then return jsonb_build_object('ok', false, 'error', 'That code was not found'); end if;
  if v_referrer = v_me then return jsonb_build_object('ok', false, 'error', 'You can''t use your own code'); end if;
  if exists (select 1 from public.referrals where referee_id = v_me) then
    return jsonb_build_object('ok', false, 'error', 'You''ve already used a referral code');
  end if;
  insert into public.referrals (referrer_id, referee_id, code)
    values (v_referrer, v_me, upper(trim(p_code)));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.apply_referral_code(text) to authenticated;

-- ── Qualify + reward on the referee's first real spend. ──────────────────────
create or replace function public.tg_referral_qualify() returns trigger
  language plpgsql security definer set search_path = public as $$
declare r record;
begin
  -- Only genuine spends of at least £3 qualify (abs() — sign varies by path).
  if new.type <> 'spend' or abs(coalesce(new.amount_pence, 0)) < 300 then return new; end if;
  select * into r from public.referrals where referee_id = new.user_id and status = 'pending' limit 1;
  if not found then return new; end if;

  perform public.wallet_credit(r.referrer_id, r.referrer_reward_pence);
  perform public.wallet_credit(r.referee_id,  r.referee_reward_pence);
  insert into public.local_wallet_transactions (user_id, type, amount_pence, description) values
    (r.referrer_id, 'topup', r.referrer_reward_pence, 'Referral reward — a friend joined OneShetland'),
    (r.referee_id,  'topup', r.referee_reward_pence,  'Referral reward — welcome to OneShetland');
  update public.referrals set status = 'rewarded', rewarded_at = now() where id = r.id;
  return new;
end $$;

drop trigger if exists referral_qualify on public.local_wallet_transactions;
create trigger referral_qualify after insert on public.local_wallet_transactions
  for each row execute function public.tg_referral_qualify();
