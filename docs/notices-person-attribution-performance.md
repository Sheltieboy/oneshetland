# Person attribution lookups — measured cost (Notices Stage 3A.2 review)

A person's display name is released only by the `notice_publisher_display` RPC (profiles are private). `loadPersonNames` (lib/notice-feed.ts, identical in the app and the website)
asks for it. Measured on the fixture backend (`supabase/tests/api/ui-fixture-env.sh`, PostgREST v14.5, the real RPC; `supabase/tests/api/measure-person-lookups.mjs`),
with a per-request delay injected to stand in for a hosted round trip.

| scenario (150 ms per RPC) | requests | names | wall time |
|---|---|---|---|
| public feed query alone | — | — | 12 ms |
| no person notices | 0 | 0 | 0 ms |
| one person notice | 1 | 1 | 172 ms |
| five person notices, five authors | 5 | 5 | 184 ms |
| 30 person notices, 30 authors (one page's maximum) | 30 | 30 | 184 ms (parallel, ~1 round trip) |
| 7 notices by ONE author | **1** | 7 | 160 ms |
| previous behaviour: one request per notice (37 notices) | 37 | — | 209 ms |
| the same 30-author page again within 2 minutes | **0** | cached | 0 ms |
| every lookup fails | — | 0 | immediate; every notice keeps "A OneShetland member" |

Slow lookups (3,000 ms per RPC, i.e. far worse than any hosted round trip): each lookup is abandoned after **1.5 s**; the page waits at most that long, then every affected
notice shows "A OneShetland member". The old behaviour waited the full 3 s.

## What bounds it
* One request per distinct author, never per notice; all in parallel (≈ one round trip whatever the count).
* At most 30 authors per call; one call per page load / refresh. No retry, no polling, no loop (a test pins that the code has none).
* A name is reused for 2 minutes, cached **per notice id** (a name remembered for one notice is never offered for another), at most 200 entries.
* A failed, erroring, malformed or timed-out lookup falls back to the approved generic label. Profiles are never read.

## Limits (acceptable for launch; revisit before person notices ship)
* The feed still waits up to 1.5 s when the RPC is unusually slow **and** a person notice is in the result. Production has no person notices today (none can be created
  until Stage 3B), so launch is unaffected. A truly non-blocking version (render the feed, then patch names in) needs a UI state change in every screen.
* If person notices become common, a **batch** RPC taking an array of notice ids would turn N parallel requests into one. That needs a new migration and is NOT proposed now:
  the measured cost is one round trip for a full page.
