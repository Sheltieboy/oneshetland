# Notices — known outstanding issues

Recorded so they are not lost between stages. Each must be resolved or consciously accepted before the stage named.

## R2 — `notify-hub-content` does not validate the notice it announces
*Found: Notices Stage 3A.1 verification (31 Oct 2026). Status: OPEN — investigate before new notice-management / lifecycle interfaces (Stage 3A.2 onwards).*

`supabase/functions/notify-hub-content` (event `notice`) pushes "New notice from {hub}" to a hub's active members. It authorises the caller as the hub's owner/admin
(`_shared/hub-content-notify-auth.ts`) but never reads the notice: `ref_id` and `title` come straight from the request body. It therefore cannot check that the
notice exists, belongs to that hub, is `status = 'published'`, has started, is unexpired, public, or is not an official import (`source IS NOT NULL`).

Impact today: limited. Only a hub owner/admin can call it, only that hub's members are reached, and both shipped clients call it immediately after creating a
published notice. It becomes material once notices can be pending, scheduled, withdrawn or resolved from the management interfaces.

Proposed direction (NOT implemented): look the notice up by `ref_id` with the service role, require it to belong to `hub_id` and to be eligible under the same rule as
`_shared/notice-broadcast.ts`, take the title from the row rather than the request, and claim a once-only marker. Needs its own tests and a coordinated app/edge change.

The characterisation test `8.1` in `supabase/tests/notice-broadcast-eligibility.node.test.ts` fails when someone starts fixing this, so the record is updated.
