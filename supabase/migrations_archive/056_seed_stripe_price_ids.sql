-- ─────────────────────────────────────────────────────────────────────────────
-- 056 · Seed Stripe price IDs into admin_config
-- ─────────────────────────────────────────────────────────────────────────────

-- TEST MODE price IDs (swap for live equivalents before going live)
INSERT INTO admin_config (key, value, description, category) VALUES
  ('stripe.price.local_pro',
   'price_1Tc21zCCZSiMQBCgGrxtOf7y',
   'Stripe Price ID for Local Pro tier (£19.99/mo). Starts with "price_".',
   'stripe'),
  ('stripe.price.local_premium',
   'price_1Tc22OCCZSiMQBCg2pUkdXC4',
   'Stripe Price ID for Local Premium tier (£49.99/mo). Starts with "price_".',
   'stripe'),
  ('stripe.price.alert_addon',
   'price_1TgmSsCCZSiMQBCgiv2nSVZS',
   'Stripe Price ID for the £10/month Urgent Alerts add-on (same product used for all future add-ons).',
   'stripe')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
