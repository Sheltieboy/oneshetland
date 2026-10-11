-- Launch Test Centre: Web becomes a first-class launch platform alongside iPhone and Android.
--
-- ADDITIVE on top of 20261125000000 (already in production — that file is not edited). No existing result is touched: there are none today,
-- and every change keeps what was already valid valid.
--   · platform vocabulary widened to web | ios | android on testers, sessions and tests ('all' still means every platform);
--   · a tester's platform list now means "these platforms"; an EMPTY list means all three (compatible with every existing row);
--   · sessions record light, non-identifying web context (browser, device class, viewport) and can never change platform / owner afterwards;
--   · a test may carry its own website wording (web_steps) so the shared journeys read correctly in a browser;
--   · the RC1 programme gains two Web-only checks, so Web has 11 applicable mandatory tests and iPhone / Android 9 each.
-- launch_test_open_session gains three optional arguments (defaults keep the already-deployed web working during the roll-out).

begin;

-- ── vocabulary ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.launch_testers drop constraint if exists launch_testers_platforms_check;
alter table public.launch_testers add constraint launch_testers_platforms_check check (platforms <@ array['web', 'ios', 'android']::text[]);
alter table public.launch_tests drop constraint if exists launch_tests_platform_check;
alter table public.launch_tests add constraint launch_tests_platform_check check (platform in ('all', 'web', 'ios', 'android'));
alter table public.launch_test_sessions drop constraint if exists launch_test_sessions_platform_check;
alter table public.launch_test_sessions add constraint launch_test_sessions_platform_check check (platform in ('web', 'ios', 'android'));

alter table public.launch_test_sessions
  add column if not exists browser      text check (char_length(browser) <= 60),
  add column if not exists device_class text check (device_class in ('desktop', 'mobile', 'tablet')),
  add column if not exists viewport     text check (viewport ~ '^[0-9]{2,5}x[0-9]{2,5}$');
alter table public.launch_tests
  add column if not exists web_steps text[] check (web_steps is null or cardinality(web_steps) <= 12);

-- A session's owner, programme and platform are fixed for life: results can never be moved between platforms by editing the session.
create or replace function public.tg_launch_session_fixed() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.user_id is distinct from old.user_id or new.programme_id is distinct from old.programme_id or new.platform is distinct from old.platform then
    raise exception 'A test session''s owner, programme and platform cannot change' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists tg_launch_session_fixed on public.launch_test_sessions;
create trigger tg_launch_session_fixed before update on public.launch_test_sessions
  for each row execute function public.tg_launch_session_fixed();

-- ── tester function: open a session (web context optional) ───────────────────────────────────────────────────────────────
drop function if exists public.launch_test_open_session(uuid, text, text, text);
create or replace function public.launch_test_open_session(
  p_programme uuid, p_platform text, p_build text default null, p_device text default null,
  p_browser text default null, p_device_class text default null, p_viewport text default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_t public.launch_testers%rowtype; v_p public.launch_test_programmes%rowtype; v_id uuid;
        v_class text := nullif(btrim(coalesce(p_device_class, '')), ''); v_vp text := nullif(btrim(coalesce(p_viewport, '')), '');
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_t from public.launch_testers where programme_id = p_programme and user_id = auth.uid() and enabled;
  if not found then raise exception 'This is not available' using errcode = '42501'; end if;
  select * into v_p from public.launch_test_programmes where id = p_programme;
  if v_p.status <> 'active' then raise exception 'This test programme is not open right now' using errcode = '55000'; end if;
  if p_platform not in ('web', 'ios', 'android') then raise exception 'Choose Web, iPhone or Android' using errcode = '22023'; end if;
  if cardinality(v_t.platforms) > 0 and not (p_platform = any (v_t.platforms)) then
    raise exception 'That platform is not part of your test assignment' using errcode = '42501';
  end if;
  if v_class is not null and v_class not in ('desktop', 'mobile', 'tablet') then v_class := null; end if;
  if v_vp is not null and v_vp !~ '^[0-9]{2,5}x[0-9]{2,5}$' then v_vp := null; end if;
  insert into public.launch_test_sessions (programme_id, user_id, platform, app_build, device_model, browser, device_class, viewport)
  values (p_programme, auth.uid(), p_platform,
          case when p_platform = 'web' then null else nullif(btrim(left(coalesce(p_build, ''), 60)), '') end,
          nullif(btrim(left(coalesce(p_device, ''), 80)), ''),
          case when p_platform = 'web' then nullif(btrim(left(coalesce(p_browser, ''), 60)), '') end,
          case when p_platform = 'web' then v_class end, case when p_platform = 'web' then v_vp end)
  on conflict (programme_id, user_id, platform) do update
    set app_build = excluded.app_build, device_model = excluded.device_model, browser = excluded.browser,
        device_class = excluded.device_class, viewport = excluded.viewport, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- ── administrator functions: platform vocabulary + web_steps ─────────────────────────────────────────────────────────────
create or replace function public.launch_test_admin_add_tester(p_programme uuid, p_email text, p_platforms text[] default '{}', p_notes text default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_user uuid; v_id uuid; v_plat text[] := coalesce(p_platforms, '{}');
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+$' then raise exception 'Enter an email address' using errcode = '22023'; end if;
  if not (v_plat <@ array['web', 'ios', 'android']::text[]) then raise exception 'Platforms can only be web, ios or android' using errcode = '22023'; end if;
  if not exists (select 1 from public.launch_test_programmes where id = p_programme) then raise exception 'No such programme' using errcode = 'P0002'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email)) and deleted_at is null limit 1;
  if v_user is null then
    raise exception 'There is no OneShetland account with that email yet. Ask them to create or sign in to their normal account first, then add them.' using errcode = 'P0002';
  end if;
  insert into public.launch_testers (programme_id, user_id, enabled, platforms, admin_notes, created_by)
  values (p_programme, v_user, true, v_plat, nullif(btrim(left(coalesce(p_notes, ''), 2000)), ''), auth.uid())
  on conflict (programme_id, user_id) do update
    set enabled = true, platforms = excluded.platforms, admin_notes = coalesce(excluded.admin_notes, public.launch_testers.admin_notes), updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.launch_test_admin_update_tester(p_tester uuid, p_enabled boolean, p_platforms text[], p_notes text)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  if not (coalesce(p_platforms, '{}') <@ array['web', 'ios', 'android']::text[]) then raise exception 'Platforms can only be web, ios or android' using errcode = '22023'; end if;
  update public.launch_testers
     set enabled = coalesce(p_enabled, enabled), platforms = coalesce(p_platforms, platforms),
         admin_notes = nullif(btrim(left(coalesce(p_notes, ''), 2000)), ''), updated_at = now()
   where id = p_tester;
  if not found then raise exception 'No such tester' using errcode = 'P0002'; end if;
end $$;

create or replace function public.launch_test_admin_update_test(p_test uuid, p_patch jsonb)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare k text;
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('title', 'purpose', 'steps', 'web_steps', 'expected_outcome', 'priority', 'mandatory', 'platform', 'sort_order', 'active', 'target_url', 'target_note',
                 'money_test_type', 'expected_max_spend_pence', 'help_text', 'effort_minutes', 'category') then
      raise exception 'Cannot edit "%"', k using errcode = '22023';
    end if;
  end loop;
  update public.launch_tests set
    title = case when p_patch ? 'title' then btrim(p_patch ->> 'title') else title end,
    category = case when p_patch ? 'category' then btrim(p_patch ->> 'category') else category end,
    purpose = case when p_patch ? 'purpose' then btrim(p_patch ->> 'purpose') else purpose end,
    steps = case when p_patch ? 'steps' then array(select btrim(x) from jsonb_array_elements_text(p_patch -> 'steps') x where btrim(x) <> '') else steps end,
    web_steps = case when p_patch ? 'web_steps' then
                  (select nullif(array(select btrim(x) from jsonb_array_elements_text(p_patch -> 'web_steps') x where btrim(x) <> ''), '{}'::text[])) else web_steps end,
    expected_outcome = case when p_patch ? 'expected_outcome' then btrim(p_patch ->> 'expected_outcome') else expected_outcome end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    mandatory = case when p_patch ? 'mandatory' then (p_patch ->> 'mandatory')::boolean else mandatory end,
    platform = case when p_patch ? 'platform' then p_patch ->> 'platform' else platform end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::integer else sort_order end,
    active = case when p_patch ? 'active' then (p_patch ->> 'active')::boolean else active end,
    target_url = case when p_patch ? 'target_url' then nullif(btrim(p_patch ->> 'target_url'), '') else target_url end,
    target_note = case when p_patch ? 'target_note' then nullif(btrim(p_patch ->> 'target_note'), '') else target_note end,
    money_test_type = case when p_patch ? 'money_test_type' then p_patch ->> 'money_test_type' else money_test_type end,
    expected_max_spend_pence = case when p_patch ? 'expected_max_spend_pence' then nullif(p_patch ->> 'expected_max_spend_pence', '')::integer else expected_max_spend_pence end,
    help_text = case when p_patch ? 'help_text' then nullif(btrim(p_patch ->> 'help_text'), '') else help_text end,
    effort_minutes = case when p_patch ? 'effort_minutes' then nullif(p_patch ->> 'effort_minutes', '')::integer else effort_minutes end,
    updated_at = now()
  where id = p_test;
  if not found then raise exception 'No such test' using errcode = 'P0002'; end if;
end $$;

-- ── admin matrix: expose the web context alongside the build ───────────────────────────────────────────────────────────────
drop function if exists public.launch_test_admin_latest(uuid);
create or replace function public.launch_test_admin_latest(p_programme uuid)
  returns table (attempt_id uuid, test_id uuid, user_id uuid, platform text, app_build text, status text, review_state text, retest_requested boolean,
                 started_at timestamptz, completed_at timestamptz, attempts_total integer, browser text, device_class text, viewport text)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  return query
    select distinct on (a.test_id, a.user_id, s.platform)
           a.id, a.test_id, a.user_id, s.platform, s.app_build, a.status, a.review_state, a.retest_requested, a.started_at, a.completed_at,
           (select count(*)::integer from public.launch_test_attempts x where x.test_id = a.test_id and x.user_id = a.user_id and x.session_id = a.session_id),
           s.browser, s.device_class, s.viewport
      from public.launch_test_attempts a
      join public.launch_test_sessions s on s.id = a.session_id
     where a.programme_id = p_programme
     order by a.test_id, a.user_id, s.platform, a.created_at desc;
end $$;
revoke all on function public.launch_test_admin_latest(uuid) from public, anon;
grant execute on function public.launch_test_admin_latest(uuid) to authenticated, service_role;

revoke all on function public.launch_test_open_session(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.launch_test_open_session(uuid, text, text, text, text, text, text) to authenticated, service_role;

-- ── RC1: website wording for the nine shared journeys, and the two Web-only checks ─────────────────────────────────────
update public.launch_tests t set web_steps = v.steps
from public.launch_test_programmes p, (values
  ('sign-in-account', array['Sign out if you are signed in.', 'Sign back in to your normal OneShetland account on the website.', 'Open your account or profile page from the menu.', 'Check your account details and controls load normally.']),
  ('home-navigation', array['Open the OneShetland home page.', 'Visit several of the main sections from the menu.', 'Go back to the home page.', 'Notice anything that looks broken, cut off or out of place.']),
  ('directory-map', array['Open Directory.', 'Search or browse and pick a real business.', 'Open its page.', 'Look at its map, location and contact buttons.']),
  ('whats-on', array['Open What''s On.', 'Pick an event.', 'Open it and read the date, time, place and any buttons.', 'Check the links and buttons behave properly.']),
  ('shop-wallet', array['Check you have enough Wallet balance for a low-value item. If you do not, choose "I couldn''t complete it" and say your balance was too low.', 'Open the item your tester guide names (or a low-value product) in the Shop.', 'Check out on the website and choose your OneShetland Wallet.', 'Look at the order confirmation and your order history.']),
  ('shop-card', array['Open the item your tester guide names (or a low-value product) in the Shop.', 'Check out on the website and pay with your own bank card.', 'Complete the payment.', 'Look at the confirmation and your order history.']),
  ('hub-donation', array['Open the Hub or campaign your tester guide names, on the website.', 'Choose a small amount and donate.', 'Follow the steps to the confirmation.', 'Go back to the Hub and check it still works.']),
  ('wallet-history', array['Open your Wallet from your account.', 'Look at your balance.', 'Look at the recent activity list.']),
  ('games-spik', array['Open Games.', 'Open at least one game and have a go.', 'Open Spik.', 'Browse or search for a word.'])
) as v(slug, steps)
where p.slug = 'rc1' and t.programme_id = p.id and t.slug = v.slug;

insert into public.launch_tests
  (programme_id, slug, category, title, purpose, steps, expected_outcome, priority, mandatory, platform, sort_order, money_test_type, effort_minutes)
select p.id, t.slug, t.category, t.title, t.purpose, t.steps, t.expected, 'high', true, 'web', t.sort_order, 'none', t.effort
from public.launch_test_programmes p cross join (values
  ('web-layout', 'Website', 'Website layout and responsive experience',
   'Catch obvious layout problems on the live website.',
   array['Open the OneShetland website normally.', 'Look at Home, Directory, What''s On, Shop, Hubs and your account or profile page.', 'Use the main menu to move around.', 'On a computer, make the browser window narrower once. On a phone, just use the normal layout.'],
   'No major overlapping text, nothing cut off, buttons stay usable, menus open and close properly, pages are readable and nothing scrolls sideways by mistake.', 110, 5),
  ('web-links', 'Website', 'Website links and browser behaviour',
   'Check ordinary browser behaviour feels right.',
   array['Click a few genuine links, such as a menu item and a business contact link.', 'Press your browser''s Back button.', 'Refresh the page, including one you are signed in on.', 'If you can, open one page directly from its address.'],
   'Links go where they should, Back behaves normally, refreshing does not break signed-in pages, and nothing leads to a dead or broken page.', 120, 3)
) as t(slug, category, title, purpose, steps, expected, sort_order, effort)
where p.slug = 'rc1'
on conflict (programme_id, slug) do nothing;

-- ── prove the end state ───────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from public.launch_tests t join public.launch_test_programmes p on p.id = t.programme_id where p.slug = 'rc1') <> 11 then raise exception 'RC1 should hold 11 tests'; end if;
  if (select count(*) from public.launch_tests t join public.launch_test_programmes p on p.id = t.programme_id where p.slug = 'rc1' and t.platform in ('all', 'web') and t.mandatory) <> 11 then raise exception 'web applicability'; end if;
  if (select count(*) from public.launch_tests t join public.launch_test_programmes p on p.id = t.programme_id where p.slug = 'rc1' and t.platform in ('all', 'ios') and t.mandatory) <> 9 then raise exception 'ios applicability'; end if;
  if (select count(*) from public.launch_tests where platform = 'all' and web_steps is null) <> 0 then raise exception 'a shared test has no website wording'; end if;
  if not has_function_privilege('authenticated', 'public.launch_test_open_session(uuid,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.launch_test_open_session(uuid,text,text,text,text,text,text)', 'EXECUTE') then raise exception 'open_session grants'; end if;
end $$;

commit;
