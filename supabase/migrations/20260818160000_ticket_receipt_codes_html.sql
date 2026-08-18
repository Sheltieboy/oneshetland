-- ============================================================================
-- The door codes rendered as literal markup in the receipt.
--
-- send-email escapes every {{variable}} by design — event titles and names are
-- user-supplied and must not be able to inject HTML. There is an escape hatch
-- for values that ARE markup: any variable whose name ends in _html is inserted
-- raw. I passed pre-rendered code boxes as {{ticket_codes}}, so the buyer got
-- <strong style="…">AYSM-RHFT</strong> printed at them instead of their ticket.
--
-- Renaming to {{ticket_codes_html}} uses the convention that already exists,
-- rather than weakening the escaping for everything else.
-- ============================================================================

update public.email_templates
set body_html = replace(body_html, '{{ticket_codes}}', '{{ticket_codes_html}}'),
    variables = array_replace(variables, 'ticket_codes', 'ticket_codes_html')
where key = 'events.tickets_confirmed';
