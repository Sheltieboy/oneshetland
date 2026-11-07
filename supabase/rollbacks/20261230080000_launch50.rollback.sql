-- Safe only while no place is active or ended (otherwise keep the table: it is the record of who was a member).
drop function if exists public.launch50_showcase(), public.launch50_mark_reminded(uuid), public.launch50_due_reminders(), public.launch50_blocks_plan_change(uuid),
  public.launch50_subscription_ended(text), public.launch50_activate(uuid, text, text, timestamptz), public.launch50_attach_subscription(uuid, text),
  public.launch50_abort_checkout(uuid), public.launch50_begin_checkout(uuid, text, uuid), public.launch50_set_showcase(uuid, boolean), public.launch50_release(uuid),
  public.launch50_reserve(uuid, text, boolean), public.launch50_status(), public.launch50_phase(), public.launch50_used(), public.launch50_cfg(text);
delete from public.email_templates where key = 'launch50.price_returns';
-- drop table public.launch50_places;   -- deliberately NOT automatic
