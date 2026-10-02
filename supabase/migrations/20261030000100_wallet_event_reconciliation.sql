-- Wallet-funded event orders can now be reconciled.
--
-- refund_reconciliation was built around a card charge: a PaymentIntent, a charge,
-- an application fee. A Wallet-funded order has none of them, so its refund could
-- never be judged — event_refund_reconciliation reported it 'unverified' forever,
-- however correct the money was. The verdict for a Wallet order is derived from the
-- Wallet ledger (the spend and every row reversing it) and the one Connect transfer
-- (how much of it came back), and is stored beside the card verdicts:
--
--   rail = 'event_ticket_wallet', charge_id = 'wallet:order:<order id>',
--   payment_intent_id NULL (there is none — nothing is invented).
--
-- New columns carry the Wallet evidence; the card columns keep their meaning.
-- Nothing about card rows changes.

alter table public.refund_reconciliation
  add column if not exists wallet_gap_pence        integer not null default 0,
  add column if not exists wallet_debit_pence      integer,
  add column if not exists wallet_credit_pence     integer,
  add column if not exists ledger_tx_id            uuid,
  add column if not exists ledger_reversal_count   integer,
  add column if not exists transfer_reversal_count integer;

-- One verdict per Wallet order, whatever happens to its key.
create unique index if not exists uq_refund_reconciliation_wallet_order
  on public.refund_reconciliation (order_id)
  where rail = 'event_ticket_wallet';

-- Same view, one more column, and a Wallet order now finds its own verdict by order id.
create or replace view public.event_refund_reconciliation as
select o.id                         as order_id,
       o.stripe_payment_intent_id   as payment_intent_id,
       o.status                     as order_status,
       o.total_pence,
       o.platform_fee_pence,
       o.refunded_at,
       coalesce(r.state, 'unverified') as reconciliation_state,
       r.transfer_gap_pence,
       r.fee_gap_pence,
       r.last_checked_at,
       r.wallet_gap_pence
  from public.event_ticket_orders o
  left join public.refund_reconciliation r
    on r.payment_intent_id = o.stripe_payment_intent_id
    or (r.rail = 'event_ticket_wallet' and r.order_id = o.id)
 where o.status = 'refunded' or o.refunded_at is not null;

revoke all on public.event_refund_reconciliation from public, anon, authenticated;
