-- Email Centre, Group 1: the welcome, the retired "email verified" duplicate, and the password reset.
-- DATA ONLY (email_templates rows). Variable names are unchanged. The previous subject/body of every row touched is kept in
-- email_templates_backup_group1 so this can be undone with the statement at the bottom.
--
-- Voice: account.welcome is personal (Darren). The password reset is automated and signed OneShetland. The signature, the help line and the
-- company footer are added by the shared layout (supabase/functions/_shared/email-layout.ts), so they are NOT repeated in these bodies.
-- Buttons are written as <a class="btn" href="…">: the layout turns them into real buttons and adds a copy-and-paste fallback link.

create table if not exists public.email_templates_backup_group1 (
  key text primary key, enabled boolean, subject text, body_html text, description text, backed_up_at timestamptz not null default now()
);
alter table public.email_templates_backup_group1 enable row level security;   -- no policies: service role / admin SQL only

create table if not exists public.email_settings_backup_group1 (
  singleton boolean primary key default true, footer_legal text, backed_up_at timestamptz not null default now()
);
alter table public.email_settings_backup_group1 enable row level security;

insert into public.email_settings_backup_group1 (footer_legal) select footer_legal from public.email_settings limit 1 on conflict (singleton) do nothing;

insert into public.email_templates_backup_group1 (key, enabled, subject, body_html, description)
select key, enabled, subject, body_html, description from public.email_templates
 where key in ('account.welcome', 'account.email_verified', 'account.password_reset')
on conflict (key) do nothing;

update public.email_templates set
  subject = 'Welcome to OneShetland',
  description = 'Personal welcome from Darren. Sent once, straight after someone confirms their email address (website /auth/callback -> send-welcome).',
  body_html = $b$<p>Hi {{name}},</p>
<p>Thanks for joining OneShetland. I'm Darren, and I started it because I wanted one easy place to find what's happening in Shetland: the shops and businesses, the events, the jobs, and everything in between.</p>
<p>Your email address is confirmed, so you're all set. Here are a few good places to start:</p>
<ul>
<li><a href="https://oneshetland.com/whats-on">See what's on</a> across the isles</li>
<li><a href="https://oneshetland.com/directory">Find a local business</a>: shops, cafés, trades and more</li>
<li><a href="https://oneshetland.com/jobs">Browse jobs and shifts</a></li>
</ul>
<a class="btn" href="https://oneshetland.com">Explore OneShetland</a>
<p>If you run a business, you can <a href="https://oneshetland.com/business#find-your-business">claim your listing, or add it for free</a>.</p>
<p>OneShetland is new and still growing. If something isn't working, or there's something you'd like to see, just reply to this email.</p>$b$,
  updated_at = now()
where key = 'account.welcome';

update public.email_templates set
  enabled = false,
  description = 'RETIRED (Email Centre Group 1). Nothing sends this: the confirmation email comes from Supabase Auth and the welcome is account.welcome. Kept for history; do not re-enable.',
  updated_at = now()
where key = 'account.email_verified';

update public.email_templates set
  subject = 'Reset your OneShetland password',
  description = 'Automated. Sent by the request-password-reset function when someone asks to reset their password. Link: single use, 1 hour.',
  body_html = $b$<p>Hi {{name}},</p>
<p>Someone asked to reset the password for the OneShetland account that uses this email address. If that was you, use the button below to choose a new password.</p>
<a class="btn" href="{{reset_url}}">Reset your password</a>
<p>The link can be used once and expires in 1 hour. If it has expired, you can <a href="https://oneshetland.com/forgot-password">ask for a new one</a>.</p>
<p><strong>Didn't ask for this?</strong> You can safely ignore this email. Your password won't change unless the link above is used. If you keep getting these emails, or you think someone is trying to get into your account, reply and we'll look into it.</p>$b$,
  updated_at = now()
where key = 'account.password_reset';

-- The footer's company line (registered office etc.), the same particulars the launch-partner email already carries.
-- Must equal COMPANY_LINE in supabase/functions/_shared/email-layout.ts (a test enforces this).
update public.email_settings set
  footer_legal = 'OneShetland is run by Darren Fullerton Consultancy Ltd · Registered in England and Wales, No. 15480428 · Registered office: 155A Tottenham Lane, London N8 9BT',
  updated_at = now();

-- ROLLBACK (run by hand if ever needed):
--   update public.email_templates t set enabled = b.enabled, subject = b.subject, body_html = b.body_html, description = b.description, updated_at = now()
--     from public.email_templates_backup_group1 b where t.key = b.key;
--   update public.email_settings s set footer_legal = b.footer_legal, updated_at = now() from public.email_settings_backup_group1 b;
