# Fetch v1 mobile screens (retired)

Moved here by Fetch v2 Step 12 (branch `fetch-v2-mobile`, base Build 148 `7317508`). Kept for reference only: nothing here is routed,
bundled or typechecked (`tsconfig.json` excludes `legacy/`).

Why they were retired: they priced Fetch on the phone (95p/mile, a client minimum and service fee, and a hard-coded production
`calculate-fee` URL), inserted `delivery_requests` and `runs` rows directly, changed request status and run links on the client, and
called `notify-drivers` — all things the Fetch v2 server now refuses or owns.

Their old addresses still exist as one-line stubs under `app/(customer)`, `app/(driver)`, `app/fetch-about*.tsx`; the group layouts
forward each to its v2 screen (`lib/fetch/mobile.ts` `v1Forward`). Delete this folder once Fetch v2 is accepted on devices.
