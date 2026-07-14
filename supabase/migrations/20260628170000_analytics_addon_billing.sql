-- ============================================================================
-- Analytics add-on billing helpers.
--
-- The £10/mo add-on is enabled two ways:
--   • card   → a Stripe subscription (Stripe auto-renews; webhook flips enabled)
--   • wallet → enabled for one month at a time; reminder-runner re-debits monthly
--
-- The gate now also enforces the wallet expiry, so a wallet add-on lapses safely
-- even if the renewal sweep is late. Card add-ons are governed by Stripe/webhook.
-- ============================================================================

create or replace function public.business_has_analytics(p_business_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.business_addons
    where business_id = p_business_id
      and addon_key = 'analytics'
      and enabled = true
      and (
        coalesce(config->>'method', 'card') <> 'wallet'        -- card: Stripe/webhook governs
        or (config->>'paid_until')::timestamptz > now()        -- wallet: must be in-period
      )
  )
$$;

-- Wallet price (pence) for the add-on — tweakable without a redeploy.
insert into public.admin_config (key, value, category, description)
values ('analytics.addon_price_pence', '1000', 'Pricing', 'Wallet price in pence for the £10/mo analytics add-on')
on conflict (key) do nothing;
