-- Restores the previous behaviour of edition_participation_payment_succeeded (from 20270102050000).
create or replace function public.edition_participation_payment_succeeded(p_link uuid, p_payment_intent text, p_charge text, p_charge_pence integer, p_stripe_fee integer default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_participations%rowtype; l public.edition_links%rowtype; e public.editions%rowtype; q record; v_pay uuid; v_dup uuid;
begin
  select * into p from public.edition_participations where link_id = p_link for update;
  if not found then raise exception 'unknown participation' using errcode = 'P0002'; end if;
  select id into v_dup from public.edition_payments where stripe_payment_intent_id = p_payment_intent and stripe_invoice_id is null;
  if v_dup is not null then return 'already_recorded'; end if;
  if p.status not in ('awaiting_payment', 'refunded') then raise exception 'participation is not awaiting payment (%)', p.status using errcode = '23514'; end if;
  if p_charge_pence is distinct from p.quoted_charge_pence then raise exception 'charged amount does not match the quoted price' using errcode = '23514', hint = 'amount_mismatch'; end if;
  select * into l from public.edition_links where id = p_link; select * into e from public.editions where id = p.edition_id;
  select * into q from public.edition_charge_breakdown('participation', p.quoted_price_pence, (select t.vat_mode from public.edition_participation_terms t where t.edition_id = p.edition_id), e.organiser_id);
  v_pay := public.edition_record_payment_row(e.organiser_id, p.business_id, 'participation', p.id, 'stripe', 'succeeded', q.price_pence, q.vat_pence, q.vat_mode, q.platform_fee_pence, q.charge_pence, q.net_to_organiser_pence,
    p_payment_intent, null, p_charge, null, null, null, null, (select created_by from public.edition_links where id = p_link), null, null);
  if p_stripe_fee is not null then update public.edition_payments set stripe_fee_pence = p_stripe_fee where id = v_pay; end if;
  update public.edition_participations set status = 'paid', payment_id = v_pay, updated_at = now() where id = p.id;
  perform public.edition_audit(e.organiser_id, p.edition_id, 'participation_paid', jsonb_build_object('link', p_link, 'charge', p_charge_pence));
  return 'recorded';
end $$;

-- Only safe when no 'duplicate_payment' exceptions exist; resolve or delete those first.
alter table public.edition_reconciliation_exceptions drop constraint if exists edition_recon_kind_check;
alter table public.edition_reconciliation_exceptions add constraint edition_recon_kind_check check (kind in ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch', 'refund_mismatch', 'destination_mismatch', 'dispute', 'amount_refused'));
