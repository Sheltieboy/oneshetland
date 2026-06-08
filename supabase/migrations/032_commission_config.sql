-- ── 032_commission_config.sql ───────────────────────────────────────────────
--
-- Seeds admin-editable platform commission rates for the three vendor-sale
-- rails. Read by supabase/functions/_shared/commission-config.ts and applied
-- by supabase/functions/_shared/commission.ts.
--
-- Defaults match the in-code DEFAULTS in commission-config.ts — keep both
-- sides in sync if you change either.
--
-- Shape: every rail has two rows — percent in basis points (200 = 2.00%) and
-- a fixed pence amount. Either can be 0. Fee is INCLUSIVE — deducted from
-- the charge, not added on top.
--
-- Boost / Units / Gifts and subscription billing are direct charges and are
-- intentionally NOT configured here.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.admin_config (key, value, description, category) VALUES
  ('fees.fetch.percent_bps',
   '0',
   'Fetch — platform fee percentage in basis points (200 = 2.00%). Taken from the fare; driver receives fare minus fee. Stacks with the fixed fee.',
   'fees'),
  ('fees.fetch.fixed_pence',
   '150',
   'Fetch — platform fee fixed amount in pence (150 = £1.50). Default flat £1.50 per delivery. Stacks with the percentage above.',
   'fees'),

  ('fees.wallet.percent_bps',
   '200',
   'Wallet — platform fee percentage in basis points (200 = 2.00%). Taken from the payment to the business.',
   'fees'),
  ('fees.wallet.fixed_pence',
   '25',
   'Wallet — platform fee fixed amount in pence (25 = £0.25). Stacks with the percentage above.',
   'fees'),

  ('fees.product.percent_bps',
   '400',
   'Product sales (future rail) — platform fee percentage in basis points (400 = 4.00%).',
   'fees'),
  ('fees.product.fixed_pence',
   '0',
   'Product sales (future rail) — platform fee fixed amount in pence.',
   'fees')
ON CONFLICT (key) DO NOTHING;
