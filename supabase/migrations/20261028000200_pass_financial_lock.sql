-- book_unit_purchases (passes): no client role may rewrite what the purchase WAS.
--
-- Same class of weakness as product_orders (fixed in 20261028000100), found by
-- the 2 Oct 2026 reconciliation: "Businesses redeem uses on their items" lets
-- the owning business UPDATE any column of its passes' purchase rows,
-- authenticated holds blanket table-level UPDATE, and the only trigger
-- (tg_zz_lock_pass_refund_columns) locks the refund columns and the use
-- balance. So a merchant could still edit paid_amount_pence, owner_id,
-- payment_intent_id, item_id, gift_id, expires_at, ... through the API.
--
-- THE ALLOWLIST IS EMPTY, and that is derived, not assumed (inspected 2 Oct):
--   · mobile and web clients contain NO write to this table — every
--     .from('book_unit_purchases') in either repo is a select;
--   · the client-callable RPCs that create a row (claim_gift, claim_gift_by_id)
--     are SECURITY DEFINER, as are every other database function that writes
--     here (business_refund_claim, business_refund_finalise, redeem_pass_atomic);
--   · every edge function that writes (confirm-unit-purchase, wallet-checkout,
--     _shared/fulfilment, reminder-runner) uses the service-role client;
--   · refund state and the use balance were already server-managed.
-- So there is no legitimate client-side change to allow. If a future flow
-- needs one, add exactly that column to `lifecycle` below, in the same change
-- as the code that writes it. A column added to the table later is locked by
-- default.
--
-- Server writes (service_role, SECURITY DEFINER functions, migrations) are
-- unaffected: public.tg_is_server_write() is true unless the session user is
-- authenticated or anon. Only UPDATE is guarded here: clients already have no
-- INSERT or DELETE policy, and the refund/use rules in
-- tg_lock_pass_refund_columns still apply on top.

create or replace function public.tg_lock_pass_financial_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  -- Client-writable columns. Deliberately empty — see above.
  lifecycle text[] := array[]::text[];
begin
  if public.tg_is_server_write() then return new; end if;
  if tg_op <> 'UPDATE' then return new; end if;

  if (to_jsonb(new) - lifecycle) is distinct from (to_jsonb(old) - lifecycle) then
    raise exception 'pass payment, amount and ownership fields are server-managed'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists tg_zz_lock_pass_financial_columns on public.book_unit_purchases;
create trigger tg_zz_lock_pass_financial_columns
  before update on public.book_unit_purchases
  for each row execute function public.tg_lock_pass_financial_columns();
