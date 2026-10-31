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

## V1 — authenticated-admin smoke test of `notify-community-notice` v14 not performed
*Recorded: Notices Stage 3A.2 (31 Oct 2026). Status: verification limitation, NOT a deployment blocker (accepted by Darren).*

When Stage 3A.1 was deployed, the planned "authorised admin request with a non-existent notice id -> 404, no push" production check could not be run: it needs a
signed-in admin session. Instead v14 was verified by bundle comparison with commit 3ba5bdd, the gateway 401 (no header), the function's own 401 (anon key), and CORS
preflight, plus 54 isolated tests of the real source. If a manual check is ever wanted: an admin-signed call with a made-up id should return 404 `Notice not found` and
send nothing. Never call it with a genuine eligible production notice.

## R2 — still open after Stage 3A.2
Stage 3A.2 only changes how notices are displayed and read; `notify-hub-content` is untouched. R2 must still be assessed and resolved before any new notice lifecycle or
management interface is introduced.

## T1 — two app tests read a stale website checkout (not a Notices defect)
*Recorded: Notices Stage 3A.2 review (31 Oct 2026).* `supabase/tests/book-service-first-discovery.node.test.ts` and `local-passes-discovery.node.test.ts` read website source from `../oneshetland-web`,
a local `main` checkout that is 65 commits behind `origin/main` (105bbd4 vs 8904ced). Against it they fail (2 of 31); pointed at a current website baseline they pass 31/31 (verified with throwaway copies,
nothing committed). They fail identically on the unmodified app baseline. Suggested maintenance (not done here): fast-forward that stale checkout, or let the tests read the website root from an environment variable.
