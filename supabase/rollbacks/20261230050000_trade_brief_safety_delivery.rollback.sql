drop function if exists public.get_trade_lead_contact(uuid), public.share_brief_contact(uuid), public.respond_to_trade_match(uuid, text, text),
  public.mark_trade_lead_viewed(uuid), public.create_brief_matches(uuid, uuid[]);
grant select on public.trade_briefs to authenticated;          -- restores the previous (leaky) table-wide read
grant update on public.trade_brief_matches to authenticated;
create policy "trade responds to own match" on public.trade_brief_matches for update
  using (exists (select 1 from public.local_businesses b where b.id = trade_brief_matches.business_id and b.owner_id = auth.uid()));
-- anon table grants and the added match columns are kept (harmless).
