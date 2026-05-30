-- ── 027_email_centre.sql ─────────────────────────────────────────────────────
--
-- Email Centre infrastructure for OneShetland.
--
-- Three tables:
--   email_settings   — global settings (from name, footer, signature etc)
--   email_templates  — one row per email type, editable from admin
--   email_log        — every email sent, for audit + delivery tracking
--
-- All writes go through service_role (edge functions + admin).
-- Authenticated users can read their own log entries.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Global email settings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_settings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Sender
  from_name        TEXT NOT NULL DEFAULT 'OneShetland',
  from_email       TEXT NOT NULL DEFAULT 'orders@oneshetland.com',
  reply_to         TEXT,
  -- Footer — shown at the bottom of every email
  footer_sign_off  TEXT DEFAULT 'Thanks,',
  footer_signature TEXT DEFAULT 'The OneShetland Team',
  footer_tagline   TEXT DEFAULT 'Everything Shetland, All in One Place',
  footer_promo_text TEXT,                -- e.g. "Download the app →"
  footer_promo_url  TEXT,
  footer_legal     TEXT DEFAULT 'OneShetland · Shetland Islands · Scotland',
  footer_socials   JSONB DEFAULT '[]',   -- [{label, url, icon}]
  -- One row only — enforced by the check below
  singleton        BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton = TRUE),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with sensible defaults
INSERT INTO public.email_settings (id) VALUES (gen_random_uuid())
ON CONFLICT DO NOTHING;

ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage email settings"
  ON public.email_settings FOR ALL
  USING  (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY "Service role full access to email_settings"
  ON public.email_settings FOR ALL USING (TRUE);

-- ── 2. Email templates ────────────────────────────────────────────────────────
-- One row per email type. Admin can edit subject + body; enabled flag lets
-- them turn off an email without deleting the template.
CREATE TABLE IF NOT EXISTS public.email_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity
  key          TEXT NOT NULL UNIQUE,   -- machine key e.g. 'fetch.delivery_confirmed'
  category     TEXT NOT NULL,          -- 'fetch' | 'shifts' | 'local' | 'account' | 'security' | 'compliance' | 'platform'
  label        TEXT NOT NULL,          -- human name shown in admin
  description  TEXT,                   -- what triggers this email
  -- Content
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  subject      TEXT NOT NULL,          -- supports {{variables}}
  body_html    TEXT NOT NULL,          -- HTML body, supports {{variables}}
  body_text    TEXT,                   -- plain text fallback
  -- Metadata
  variables    TEXT[] DEFAULT '{}',    -- list of available {{variable}} names
  requires_optin BOOLEAN DEFAULT FALSE, -- true = only send if user opted in (marketing)
  postmark_stream TEXT DEFAULT 'outbound', -- 'outbound' (transactional) or 'broadcast' (marketing)
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_category ON public.email_templates(category);
CREATE INDEX IF NOT EXISTS idx_email_templates_key      ON public.email_templates(key);

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage email templates"
  ON public.email_templates FOR ALL
  USING  (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY "Service role full access to email_templates"
  ON public.email_templates FOR ALL USING (TRUE);

-- ── 3. Email log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key    TEXT NOT NULL,
  recipient_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('sent', 'delivered', 'bounced', 'failed', 'skipped')),
  postmark_id     TEXT,           -- MessageID from Postmark for webhook lookups
  error_message   TEXT,
  metadata        JSONB DEFAULT '{}',  -- e.g. { shift_id, booking_id } for context
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_log_recipient   ON public.email_log(recipient_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_template    ON public.email_log(template_key, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_postmark_id ON public.email_log(postmark_id) WHERE postmark_id IS NOT NULL;

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see their own email log"
  ON public.email_log FOR SELECT
  USING (recipient_id = auth.uid());
CREATE POLICY "Admins see all email logs"
  ON public.email_log FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY "Service role full access to email_log"
  ON public.email_log FOR ALL USING (TRUE);

-- ── 4. Seed email templates ───────────────────────────────────────────────────
INSERT INTO public.email_templates (key, category, label, description, subject, body_html, variables, postmark_stream) VALUES

-- ACCOUNT
('account.welcome',           'account', 'Welcome to OneShetland',         'Sent on sign-up',                    'Welcome to OneShetland, {{name}}!',      '<h2>Welcome, {{name}}!</h2><p>Your account is ready. Everything Shetland is now in one place.</p>', ARRAY['name','email'], 'outbound'),
('account.email_verified',    'account', 'Email verified',                  'After email confirmation',           'Your email is confirmed — you''re all set', '<h2>You''re confirmed!</h2><p>Hi {{name}}, your OneShetland account is active.</p>', ARRAY['name'], 'outbound'),
('account.password_reset',    'account', 'Password reset',                  'Triggered by password reset request','Reset your OneShetland password',        '<h2>Password reset</h2><p>Click below to reset your password. This link expires in 1 hour.</p><p><a href="{{reset_url}}">Reset password</a></p>', ARRAY['name','reset_url'], 'outbound'),
('account.driver_approved',   'account', 'Driver application approved',     'When admin approves a driver',       'You''re approved to drive for Fetch!',   '<h2>Great news, {{name}}!</h2><p>Your driver application has been approved. You can now create runs and start earning.</p>', ARRAY['name'], 'outbound'),
('account.driver_rejected',   'account', 'Driver application rejected',     'When admin rejects a driver',        'Update on your Fetch driver application', '<h2>Hi {{name}},</h2><p>Unfortunately we''re unable to approve your driver application at this time. {{reason}}</p>', ARRAY['name','reason'], 'outbound'),
('account.business_approved', 'account', 'Business listing approved',       'When admin verifies a business',     'Your business is now verified on OneShetland', '<h2>{{business_name}} is verified!</h2><p>Your listing is now featured in the Local directory with a verified badge.</p>', ARRAY['name','business_name'], 'outbound'),

-- SECURITY
('security.new_signin',       'security', 'New sign-in alert',              'Sign-in from new device/location',  'New sign-in to your OneShetland account', '<h2>New sign-in detected</h2><p>Hi {{name}}, we noticed a sign-in on {{device}} at {{time}}. If this was you, no action needed.</p>', ARRAY['name','device','time','ip'], 'outbound'),
('security.email_changed',    'security', 'Email address changed',          'After email update',                'Your OneShetland email address was changed', '<h2>Email changed</h2><p>Your account email was changed to {{new_email}}. If you didn''t do this, contact us immediately.</p>', ARRAY['name','new_email'], 'outbound'),
('security.password_changed', 'security', 'Password changed',              'After password update',             'Your OneShetland password was changed',  '<h2>Password changed</h2><p>Hi {{name}}, your password was just updated. If you didn''t do this, reset your password immediately.</p>', ARRAY['name'], 'outbound'),
('security.account_suspended','security', 'Account suspended',             'When admin suspends an account',    'Your OneShetland account has been suspended', '<h2>Account suspended</h2><p>Hi {{name}}, your account has been suspended. {{reason}} Please contact us if you believe this is an error.</p>', ARRAY['name','reason'], 'outbound'),

-- COMPLIANCE
('compliance.terms_accepted', 'compliance', 'Terms of service accepted',   'Sent + logged when user accepts T&C','Your OneShetland terms of service acceptance', '<h2>Terms accepted</h2><p>Hi {{name}}, this confirms you accepted the OneShetland Terms of Service (v{{version}}) on {{date}}.</p>', ARRAY['name','version','date','ip'], 'outbound'),
('compliance.privacy_accepted','compliance','Privacy policy accepted',      'Sent + logged when user accepts PP', 'Your OneShetland privacy policy acceptance', '<h2>Privacy policy accepted</h2><p>Hi {{name}}, this confirms you accepted the OneShetland Privacy Policy (v{{version}}) on {{date}}.</p>', ARRAY['name','version','date','ip'], 'outbound'),
('compliance.data_export',    'compliance', 'Your data export is ready',   'GDPR data export completed',         'Your OneShetland data export is ready',  '<h2>Your data is ready</h2><p>Hi {{name}}, your data export is ready to download. The link expires in 24 hours.</p><p><a href="{{download_url}}">Download your data</a></p>', ARRAY['name','download_url'], 'outbound'),
('compliance.account_deleted','compliance', 'Account deleted',             'After account deletion',             'Your OneShetland account has been deleted', '<h2>Account deleted</h2><p>Hi {{name}}, your OneShetland account and all associated data has been permanently deleted as requested.</p>', ARRAY['name'], 'outbound'),

-- FETCH
('fetch.request_confirmed',   'fetch', 'Delivery request confirmed',        'Customer submits a delivery request','Your Fetch delivery request is confirmed', '<h2>Request confirmed</h2><p>Hi {{name}}, your delivery request from {{pickup}} to {{destination}} has been received. We''ll notify you when a driver picks it up.</p>', ARRAY['name','pickup','destination','request_id'], 'outbound'),
('fetch.driver_matched',      'fetch', 'Driver matched to your request',    'Driver accepts a request',           'A driver is on their way for your Fetch delivery', '<h2>Driver matched!</h2><p>Hi {{name}}, {{driver_name}} is collecting your item from {{pickup}}.</p>', ARRAY['name','driver_name','pickup','estimated_time'], 'outbound'),
('fetch.item_collected',      'fetch', 'Item collected',                    'Driver marks item as collected',     'Your item has been collected by your Fetch driver', '<h2>Item collected</h2><p>Hi {{name}}, your item is on its way to {{destination}}.</p>', ARRAY['name','destination','driver_name'], 'outbound'),
('fetch.delivered',           'fetch', 'Delivery completed',                'Driver marks as delivered',          'Your Fetch delivery is complete',        '<h2>Delivered!</h2><p>Hi {{name}}, your item has been delivered to {{destination}}. Thank you for using Fetch.</p>', ARRAY['name','destination'], 'outbound'),
('fetch.cancelled',           'fetch', 'Delivery request cancelled',        'Request cancelled by customer/driver','Your Fetch request has been cancelled', '<h2>Request cancelled</h2><p>Hi {{name}}, your delivery request has been cancelled. {{reason}}</p>', ARRAY['name','reason'], 'outbound'),
('fetch.driver_payout',       'fetch', 'Fetch payout sent',                 'Driver payout processed',            'Your Fetch earnings are on their way',  '<h2>Payout sent!</h2><p>Hi {{name}}, £{{amount}} for your recent {{count}} delivery has been sent to your bank account.</p>', ARRAY['name','amount','count'], 'outbound'),

-- SHIFTS
('shifts.application_received','shifts','Shift application received',       'Employer: new application on shift', 'New application for {{shift_title}}',   '<h2>New application</h2><p>Hi {{name}}, {{worker_name}} has applied for your shift "{{shift_title}}".</p>', ARRAY['name','worker_name','shift_title','shift_id'], 'outbound'),
('shifts.application_accepted','shifts','Application accepted',             'Worker: employer accepts application','Your shift application has been accepted', '<h2>You''re in!</h2><p>Hi {{name}}, your application for "{{shift_title}}" on {{shift_date}} has been accepted.</p>', ARRAY['name','shift_title','shift_date','location'], 'outbound'),
('shifts.application_rejected','shifts','Application rejected',             'Worker: employer rejects application','Update on your application for {{shift_title}}', '<h2>Hi {{name}},</h2><p>Your application for "{{shift_title}}" was not successful this time. Keep checking for new shifts.</p>', ARRAY['name','shift_title'], 'outbound'),
('shifts.shift_cancelled',    'shifts', 'Shift cancelled',                  'Shift cancelled by employer',        '{{shift_title}} has been cancelled',    '<h2>Shift cancelled</h2><p>Hi {{name}}, unfortunately "{{shift_title}}" on {{shift_date}} has been cancelled by the employer.</p>', ARRAY['name','shift_title','shift_date'], 'outbound'),
('shifts.reminder',           'shifts', 'Shift reminder',                   '24hr before shift starts',           'Reminder: {{shift_title}} is tomorrow', '<h2>Shift reminder</h2><p>Hi {{name}}, just a reminder that "{{shift_title}}" starts tomorrow at {{shift_time}} at {{location}}.</p>', ARRAY['name','shift_title','shift_time','location'], 'outbound'),
('shifts.completed_worker',   'shifts', 'Shift completed — worker',         'Employer confirms shift complete',    'Your shift is complete — payout on its way', '<h2>Shift complete!</h2><p>Hi {{name}}, {{employer_name}} has confirmed "{{shift_title}}" is complete. Your payment is on its way.</p>', ARRAY['name','shift_title','employer_name','amount'], 'outbound'),

-- LOCAL
('local.booking_confirmed',   'local', 'Booking confirmed',                 'Customer books a service',           'Your booking at {{business_name}} is confirmed', '<h2>Booking confirmed</h2><p>Hi {{name}}, your booking for {{service_name}} at {{business_name}} is confirmed for {{date}} at {{time}}.</p>', ARRAY['name','business_name','service_name','date','time'], 'outbound'),
('local.booking_reminder',    'local', 'Booking reminder',                  '24hr before booking',                'Reminder: {{service_name}} at {{business_name}} tomorrow', '<h2>Booking reminder</h2><p>Hi {{name}}, your {{service_name}} at {{business_name}} is tomorrow at {{time}}.</p>', ARRAY['name','business_name','service_name','time'], 'outbound'),
('local.booking_cancelled',   'local', 'Booking cancelled',                 'Booking cancelled by either party',  'Your booking at {{business_name}} has been cancelled', '<h2>Booking cancelled</h2><p>Hi {{name}}, your booking for {{service_name}} at {{business_name}} has been cancelled. {{reason}}</p>', ARRAY['name','business_name','service_name','reason'], 'outbound'),
('local.wallet_topup',        'local', 'Wallet top-up receipt',             'Wallet top-up confirmed',            'Your OneShetland wallet has been topped up', '<h2>Top-up confirmed</h2><p>Hi {{name}}, £{{amount}} has been added to your Local Wallet. New balance: £{{balance}}.</p>', ARRAY['name','amount','balance'], 'outbound'),
('local.subscription_started','local', 'Subscription started',             'Business subscribes to Pro/Premium', 'Welcome to OneShetland {{tier}}!',      '<h2>You''re on {{tier}}!</h2><p>Hi {{name}}, your {{business_name}} subscription is active. {{features}}</p>', ARRAY['name','business_name','tier','features'], 'outbound'),
('local.subscription_receipt','local', 'Subscription renewal receipt',      'Monthly subscription renewal',       'OneShetland {{tier}} subscription renewed', '<h2>Subscription renewed</h2><p>Hi {{name}}, your {{tier}} subscription for {{business_name}} has renewed. £{{amount}} charged.</p>', ARRAY['name','business_name','tier','amount','next_date'], 'outbound'),
('local.subscription_cancelled','local','Subscription cancelled',           'Business cancels subscription',      'Your OneShetland subscription has been cancelled', '<h2>Subscription cancelled</h2><p>Hi {{name}}, your {{tier}} subscription for {{business_name}} will end on {{end_date}}.</p>', ARRAY['name','business_name','tier','end_date'], 'outbound'),

-- PLATFORM (broadcast / opt-in)
('platform.newsletter',       'platform', 'Community newsletter',           'Periodic newsletter — opt-in',       'What''s on in OneShetland',             '<h2>What''s on in OneShetland</h2><p>{{content}}</p>', ARRAY['name','content'], 'broadcast'),
('platform.feature_update',   'platform', 'New feature announcement',       'New feature launched',               'New on OneShetland: {{feature_name}}',  '<h2>New on OneShetland</h2><p>Hi {{name}}, {{content}}</p>', ARRAY['name','feature_name','content'], 'broadcast')

ON CONFLICT (key) DO NOTHING;

-- ── 5. Grants ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON public.email_settings  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.email_templates TO authenticated;
GRANT SELECT                 ON public.email_log       TO authenticated;
GRANT ALL                    ON public.email_settings  TO service_role;
GRANT ALL                    ON public.email_templates TO service_role;
GRANT ALL                    ON public.email_log       TO service_role;
