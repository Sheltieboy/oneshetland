-- Local Wallet economics improvement, 1 Oct 2026.
--
-- The economic audit found the flat 2%+25p wallet fee genuinely poor for
-- small transactions (27% on a real £1.00 payment) and, separately, that a
-- wallet SPEND incurs no Stripe cost of its own — the only real external
-- cost in the whole lifecycle is the card-processing fee paid once, at
-- top-up. Both findings point the same way: a tier-aware, percentage-only
-- rate, lower for Premium as a subscription perk.
--
-- fees.wallet.percent_bps is KEPT, unchanged in value, as the fallback a
-- business resolves to if a tier-specific key is ever missing or blank —
-- see getWalletCommissionConfig(). Nothing that already reads it breaks.

update public.admin_config
   set value = '0',
       description = 'Wallet — fixed fee in pence, stacks with whichever percentage below applies. 0 = percentage-only (the current model).'
 where key = 'fees.wallet.fixed_pence';

update public.admin_config
   set description = 'Wallet — LEGACY global fee percentage in basis points (200 = 2.00%). Used only as a fallback if a tier-specific rate below is missing or blank; prefer pro_percent_bps / premium_percent_bps.'
 where key = 'fees.wallet.percent_bps';

insert into public.admin_config (key, value, description, category)
values
  ('fees.wallet.pro_percent_bps', '150',
   'Wallet — fee percentage in basis points for Pro-tier businesses (150 = 1.50%). Basis points: divide by 100 for the percentage.',
   'fees'),
  ('fees.wallet.premium_percent_bps', '100',
   'Wallet — fee percentage in basis points for Premium-tier businesses (100 = 1.00%), lower than Pro as a subscription benefit. Basis points: divide by 100 for the percentage.',
   'fees'),
  ('wallet.savings.card_percent_bps', '175',
   'Wallet savings estimate — the CONFIGURABLE comparison benchmark (175 = 1.75%) shown to merchants as "a typical card payment", not a real processor contract. Change this to adjust the comparison, not any real cost.',
   'fees'),
  ('wallet.savings.card_fixed_pence', '0',
   'Wallet savings estimate — fixed pence added to the comparison benchmark above. 0 = percentage-only benchmark.',
   'fees'),
  ('wallet.savings.enabled', 'true',
   'Wallet savings estimate — "true" shows the "Saved with Wallet" merchant-facing comparison; "false" hides it cleanly everywhere it would otherwise appear.',
   'fees')
on conflict (key) do update
  set value = excluded.value, description = excluded.description, category = excluded.category;

-- ── Safe, narrow exposure of the savings benchmark to merchants ────────────
--
-- admin_config itself is admin-only (RLS: role = 'admin'). The benchmark is
-- meant to be shown to a business owner on their own dashboard, so it needs
-- a SECURITY DEFINER door — but one that hands over exactly these three
-- values and nothing else from a table that also holds every other rail's
-- commission rate and Stripe price IDs.
create or replace function public.get_wallet_savings_benchmark()
returns table(card_percent_bps integer, card_fixed_pence integer, enabled boolean)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    coalesce((select value::integer from public.admin_config where key = 'wallet.savings.card_percent_bps'), 175),
    coalesce((select value::integer from public.admin_config where key = 'wallet.savings.card_fixed_pence'), 0),
    coalesce((select value from public.admin_config where key = 'wallet.savings.enabled'), 'true') = 'true';
$function$;

revoke all on function public.get_wallet_savings_benchmark() from public, anon;
grant execute on function public.get_wallet_savings_benchmark() to authenticated, service_role;
