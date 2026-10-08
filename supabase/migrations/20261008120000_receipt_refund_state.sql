/**
 * The merchant's receipt list could not tell a refunded payment from a live one.
 *
 * get_business_wallet_receipts selects `type = 'spend'` and returns nothing about
 * refunds. The reversal is a separate `type = 'refund'` row, which that filter
 * excludes outright — so after a real refund the merchant still saw
 * "£3.00 paid · £2.85 to you · £0.15 fee" with a live Refund button, and pressing
 * it again produced a second "Refunded" message. No money moved (the claim
 * returns already_refunded, the transfer reads as fully reversed, finalisation
 * short-circuits to already_complete, and the ledger's idempotency key is
 * UNIQUE), but the merchant was told something untrue about their own takings.
 *
 * The clients could not have fixed this: they were never sent the state.
 *
 * Three columns are appended — appended, so every existing caller keeps the
 * fields it already reads in the positions it already reads them — and the
 * answer is derived from the ledger itself rather than from anything a client
 * says: a receipt is refunded when, and only when, a wallet row of type
 * 'refund' points at it via reverses_transaction_id.
 *
 * The original spend stays in history. A refund is not an erasure, and a
 * merchant reconciling a month needs to see that the money came in before it
 * went back out.
 *
 * DELIBERATELY NOT 'pending'. A refund that has claimed its source but has not
 * yet credited the wallet has no reversal row, so it reports 'none' and keeps
 * its Refund button — which is exactly the recovery path wallet-refund-business
 * tells the merchant to take ("press Refund again to finish it"). Reporting
 * 'pending' here would take that button away at the one moment it is needed.
 *
 * Nothing about the money changes: no financial table is touched, and
 * wallet_reverse_debit, the Stripe reversal and Loyalty are all untouched.
 * The auth rule, the ownership rule, the ordering and the limit are carried
 * over verbatim.
 */

-- The return type gains columns, so this cannot be a CREATE OR REPLACE.
drop function if exists public.get_business_wallet_receipts(uuid, integer);

create function public.get_business_wallet_receipts(p_business_id uuid, p_limit integer default 20)
returns table (
  id                    uuid,
  created_at            timestamptz,
  gross_pence           integer,
  fee_pence             integer,
  cashback_pence        integer,
  net_pence             integer,
  customer_first_name   text,
  stripe_transfer_id    text,
  refund_state          text,
  refunded_at           timestamptz,
  refund_transaction_id uuid
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'auth_required';
  end if;

  if not exists (
    select 1 from public.local_businesses
     where id = p_business_id and owner_id = v_user_id
  ) then
    raise exception 'not_business_owner';
  end if;

  return query
    select
      t.id,
      t.created_at,
      abs(t.amount_pence)                                       as gross_pence,
      t.platform_fee_pence                                      as fee_pence,
      t.cashback_pence                                          as cashback_pence,
      case when t.platform_fee_pence is null
           then null
           else abs(t.amount_pence) - t.platform_fee_pence - coalesce(t.cashback_pence, 0)
      end                                                       as net_pence,
      nullif(split_part(coalesce(p.full_name, ''), ' ', 1), '') as customer_first_name,
      t.stripe_transfer_id,
      -- Refunded means the money went back, and the ledger is the only thing
      -- that knows. A row that merely claimed its source has not credited
      -- anyone yet and is still 'none'.
      case when rev.id is null then 'none' else 'refunded' end  as refund_state,
      rev.created_at                                            as refunded_at,
      rev.id                                                    as refund_transaction_id
    from public.local_wallet_transactions t
    left join public.profiles p on p.id = t.user_id
    -- The reversal that names THIS spend. reverses_transaction_id is the link
    -- wallet_reverse_debit writes, so one receipt can never pick up another
    -- receipt's refund.
    left join lateral (
      select r.id, r.created_at
        from public.local_wallet_transactions r
       where r.reverses_transaction_id = t.id
         and r.type = 'refund'
       order by r.created_at
       limit 1
    ) rev on true
    where t.business_id = p_business_id
      and t.type        = 'spend'
    order by t.created_at desc
    limit greatest(1, least(p_limit, 100));
end;
$$;

-- Restored as they were before the drop: PUBLIC keeps the default EXECUTE a new
-- function is created with, and the named roles are re-granted explicitly.
grant execute on function public.get_business_wallet_receipts(uuid, integer)
  to anon, authenticated, service_role;
