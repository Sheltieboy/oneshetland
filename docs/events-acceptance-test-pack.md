# Events & Regular Activities: final acceptance test pack (R1 to R20)

Prepared 7 Nov 2026. **Updated 07:25 UTC: the tester migration (`20261230030000`, history 287) is APPLIED and the website tester gate (web `main` `3ce7cf5`) is DEPLOYED.** Nothing has been enabled: the public flag is OFF, the submissions switch is ABSENT (closed), the tester list is EMPTY, no accounts were created, no test event exists, nothing was sent to anyone, Fetch is paused.

## 1. How testing is kept away from the public

Three independent layers stand between the public and the new feature. Testing never needs to loosen the public ones.

| Layer | Today | What it does |
|---|---|---|
| Website flag `EVENT_FRONT_DOOR` (server env on Netlify) | unset | When `on`, entry-point links appear and `/whats-on/add` opens for everyone. **Stays unset for all testing.** |
| Website gate | live | `/whats-on/add` and the member pages are a 404 for everyone except an admin (preview) |
| Database switch `events.member_submissions` | absent = closed | `open` = every signed-in member; **`testers` = only listed accounts** (new, below); anything else = closed |

**The gap this closes.** Today a non-admin account cannot even see the pages, so "an ordinary member" cannot be tested on the real site without turning the public flag on. The prepared **tester allowlist** (migration `20261230030000` + a small website gate change) lets only accounts you name reach the pages and submit. Everyone else still gets a 404 / "not open yet". Entry-point links stay hidden (they depend only on the public flag), so testers use the direct address `https://oneshetland.com/whats-on/add`.

Sign-in cannot be tested on a local copy of the site: the sign-in check (Turnstile) is bound to the production domain. So signed-in tests run on the real site.

**State today:** both pieces are LIVE but inactive (no tester is listed and the switch is closed, so the new code path changes nothing for anyone).
- Backend: migration applied and registered 7 Nov 07:20 UTC; rolled-back dry run 17/17 before and after applying; the full 84-criteria check still 84/84; data checksums and row counts identical before and after; backend `main` `f1e98b2`.
- Web: `main` `3ce7cf5`; full suite 1,647/1,647 including `tests/event-gate-viewers.test.mjs`, which runs the real gate for every viewer type.
- Existing "Launch Test Centre" has its own tester list (`launch_testers`); the submissions allowlist is deliberately separate so enrolling someone as a launch tester never silently lets them submit events.

### Who can see what (settles the "can admins preview?" question: they can, and links stay hidden for everyone)

Two separate things were being described together. **Page access** and **links to the page** are different rules:

| Viewer | Public flag OFF (today): can OPEN `/whats-on/add` and the member pages? | Public flag OFF: shown entry-point LINKS? | Public flag ON |
|---|---|---|---|
| Signed out | No: 404 | No | Yes (asked to sign in) + links shown |
| Ordinary signed-in member | **No: 404** | No | Yes + links shown |
| Allowlisted tester (switch `testers`, listed) | **Yes** (direct address) | No | Yes + links shown |
| Admin | **Yes: preview** (direct address) | **No** (links never depend on who you are) | Yes + links shown |

Proven by executing the real gate: `tests/event-gate-viewers.test.mjs` (9 tests: signed out, member, tester, admin x flag off/on, tester function missing/erroring/non-boolean). An earlier report line that a signed-in user got a 404 referred to an ordinary member, not an admin. Separately, being allowed to open the page does not mean being allowed to submit: submitting also needs the database switch (`open`, or `testers` and listed; staff may always submit and their submissions only wait in the queue).

## 2. Already run (no accounts needed)

| Test | Result |
|---|---|
| R1 real RPCs, permissions, occurrences, ticket safeguards, moderation, contributor tools, cancelled-event read, real refund function (rolled-back, real roles, real schema) | **84/84 passed again at 07:15 UTC** (after the function and website deploys) |
| R2 storage policy | read-only: bucket `event-media` public, 10 MB, jpeg/png/webp; insert allowed only under your own `<uid>/` folder, so the poster path is permitted. Real upload still to do (Part A) |
| R3 dark gating (signed out) | live: `/whats-on/add` 404, no entry link anywhere (exact-link count 0 on 13 pages) |
| R9 Social Studio | the 05:40 UTC composer run on the new code was healthy: HTTP 200, `ok:true`, `errors:[]`, one normal `wird_of_day` draft, new recipes ran without error, skips were all expected (Saturday); no event-related posts (none are eligible yet) |
| R10 Regular Activities (public pages) | the 3 live activity pages, the list and `/whats-on/regular` are identical before and after every deploy |
| R12 app compatibility | by design and tested: a run's parent `starts_at/ends_at` stay first/last live date; no existing event changed |
| R18 flag off | identical pages, zero entry links (checked before and after the deploy) |

## 3. Accounts and fixtures

| Needed for | Account | Exists? |
|---|---|---|
| Staff paths, contributor paths as the submitter | your **admin** account (oneshetland.com address) | yes. It also owns the real hub "OneShetland": do NOT use that hub for test events |
| Business owner and hub owner (R14 to R16) | a non-admin account that owns `ZZ TEST — OneShetland Acceptance Fixture` (business) and `ZZ TEST — Wallet Acceptance Hub` (hub) | **yes, one gmail account created on the project's first day owns both: please confirm it is yours** |
| Ordinary member with NO business or hub (R13) | a new adult, non-admin account | **no. You need to create it (or approve me to). 18+; a plus-address of your own email works** |
| Hub committee member (R15) | a second account that is a committee member of the ZZ hub | optional; the ZZ owner can promote one |
| Ticket buyer (R7, R8) | any account of yours | optional; the 2nd/3rd account can buy a FREE ticket |

I will not create accounts, type credentials, or send email. Sign-ins are done by you.

## 4. What you personally test, in order

### Part A: needs NOTHING new. Your admin account on the real site, today
Admin preview works with the flag off and the switch closed (staff may submit while closed; their submissions only wait in the queue). This exercises moderation, the contributor tools (you are the submitter, so you are the contributor), the poster upload and multi-date events.

1. **R3/R4: the door.** Signed in as admin open `https://oneshetland.com/whats-on/add`. You should see "Who is organising this?" (your hub "OneShetland" is listed; ignore it) and "Independent event". Open the same address signed out or in a private window: it must be a 404.
2. **Independent pantomime with multiple dates, poster upload (R2/R4).** Choose Independent, then "Theatre & Performing Arts". Organiser name `ZZ TEST Lerwick Players`, title `ZZ TEST — Pantomime`. Add 6 dates (a matinee and an evening on each of 3 days; use the "copy to next day" button; give one a note). Upload a small JPEG/PNG poster. Tick the adult confirmation ("I confirm I am 18 or over and am authorised to submit this event."), review, submit. Expect the success page and the entry in `/account/event-submissions` as pending. It must NOT appear on the public site yet.
3. **R5: moderation.** `/admin/events/submissions`: open it, check what staff see (organiser name, dates, poster), **approve**. Then check, as a stranger (private window): the event page (credited to `ZZ TEST Lerwick Players`, never OneShetland, poster shown, performances list, "Ticket details come from the organiser", no buy button), What's On shows ONE card with "Next: …· 6 performances", the calendar shows each performance on its own day, the homepage shows it at most once. Reject and "ask for changes" on two more throwaway submissions to see the reasons reach the submitter.
4. **R6: contributor changes and cancellations.** `/account/event-submissions` then the event: cancel ONE performance (the page marks it Cancelled, the rest stay live, parent date moves to the next live one); undo; "Ask for a change" (move a date) and approve it in `/admin/events/changes`; trust yourself in that screen and make a second change (it applies automatically); finally cancel the WHOLE event: the page stays up marked **Cancelled** (banner, no ticket controls), the event leaves What's On, the calendar and the homepage. Undo within 24 hours restores it.
5. **Retire fixtures** (section 6) before Monday 05:40 UTC.
6. **R10: existing Regular Activities.** Browse `/whats-on/regular` and the three live activity pages (unchanged). Do NOT edit the real ones. Their owner-side behaviour (schedule, cancel one session, holiday break) is tested with the ZZ business in Part B.
7. **R11/R20: accessibility.** Walk step 2 by keyboard only, at phone width and desktop width. Focus should land on each step heading; nothing should need a mouse.

### Part B: after you approve the allowlist, with the ZZ account (business and hub owner)
Needs approvals 1 to 3 in section 7. Sign in as the ZZ gmail account on the real site.
8. **R14/R16 business and hub together.** `/whats-on/add` lists the ZZ business and the ZZ hub (only those), then "Independent event". Choose the business, then an event category: you land on the business's events screen (the commercial-terms gate intact). Add a free event. Choose the hub, then an event: you land on the hub's events screen. Choose either, then a regular-activity category: you land on that business's or hub's activity editor.
9. **R15 committee member** (optional second account): the hub is listed for the committee member too; a plain hub member sees no hub.
10. **R7 ticketed regression (existing path).** On the ZZ business add an event with a FREE ticket type. Buy a free ticket with a second account: ticket issued, shows in My tickets, counters correct.
11. **R8 buyers and cancellation (sends email to your own test buyer: needs approval 5).** Cancel that event as the ZZ business owner: the pre-confirm panel shows the buyer count and refund path; the buyer gets the cancellation email and an in-app note. Repeat on a ZZ hub event (hub cancel now notifies too). A community event with a buyer cannot be cancelled by its contributor (it points to support).
12. **R10 owner side.** On the ZZ business create a regular activity with weekly times, cancel one session, add a holiday break, check the public activity page and that nothing says "OneShetland" as the organiser.

### Part C: the ordinary member (R13), with a NEW account
13. Create the account yourself (adult, non-admin), verify it, and send me its address so I can add it to the tester list.
14. `/whats-on/add`: it shows ONLY "Independent event" and the calm note "You don't run a business or a hub on OneShetland yet…". Submit an independent event: it reaches the queue and nothing is public until staff approve. Choose a regular-activity category: no form; it says a regular activity needs a business or a hub and offers "Start a free hub" and "Add your business". After 3 submissions the gentle hub suggestion appears on My submissions.
15. As that member confirm what they must NOT be able to do: reach `/admin/...` (sign-in/404), approve their own submission, edit someone else's event (all proven in R1, but see it once).

### Part D: after activation (separate decision)
R18 entry points present exactly once per surface with the flag on, and no link leads to a 404; R19 you approve the Community Guidelines section; first live submissions watched in the queue.

## 5. R1 to R20: status board

| # | Test | Who | Needs your approval? | Status |
|---|---|---|---|---|
| R1 | real RPCs and RLS | Claude | no | PASSED 84/84 (7 Nov) |
| R2 | poster upload to storage | you (Part A step 2) | no | policy verified; real upload pending |
| R3 | dark gating | Claude + you | no | signed-out verified; admin/non-admin pending |
| R4 | submission as an ordinary adult member | you (A as admin; C as a member) | C needs account + allowlist | pending |
| R5 | moderation (approve, reject, changes) | you (Part A 3) | no | pending |
| R6 | contributor changes and cancellations | you (Part A 4) | no | pending |
| R7 | free-ticket regression | you (Part B 10) | allowlist | pending |
| R8 | ticket buyers and cancellation emails | you (Part B 11) | yes (real email to your test buyer) | pending |
| R9 | Social Studio | Claude | no | PASSED (05:40 run healthy) |
| R10 | Regular Activities | Claude (public) + you (owner side) | no | public PASSED; owner side pending |
| R11 | accessibility and mobile | Claude (automated) + you (hands-on) | no | automated done in builds; hands-on pending |
| R12 | app compatibility | Claude | no | PASSED by design and test |
| R13 | member with no business or hub | you (Part C) | account + allowlist | pending |
| R14 | member with a business | you (Part B 8) | allowlist | pending |
| R15 | hub owner and committee member | you (Part B 8, 9) | allowlist | pending |
| R16 | business and hub together | you (Part B 8) | allowlist | pending |
| R17 | hub suggestion after 3 submissions | you (Part C 14) | account + allowlist | pending |
| R18 | entry points off/on | Claude | no | OFF verified; ON verified locally; live ON only at activation |
| R19 | Community Guidelines wording | you | no | live now; needs your read |
| R20 | keyboard and mobile | you (Part A 7) | no | automated done; hands-on pending |

## 6. Exposure and cleanup (read before approving a test event)

- **Approving a test event makes it PUBLIC** (listings, calendar, sitemap) until you retire it. Use obvious `ZZ TEST` names and retire immediately after checking. Retire with staff status `archived` (hidden from the public; the contributor can still see it):
  `update public.events set status = 'archived' where title like 'ZZ TEST%' and source = 'community_submission';`
  A data write: do it only with your approval, or ask me to.
- **Before Monday 05:40 UTC** retire every approved test event: the Monday "What's On" roundup draws from published events in the next 7 days.
- A whole-event cancellation (Part A 4) leaves the page up marked Cancelled; retire it too.
- Uploaded test posters stay in `event-media/<uid>/events/`; the owner can delete them (policy `event-media owner delete`).
- Existing real business and activity data must not be touched: use only the `ZZ TEST` business, hub and your own submissions.

## 7. Approvals requested (nothing proceeds without each)

1. ~~Apply migration `20261230030000_event_submissions_testers.sql`~~ **DONE 7 Nov 07:20 UTC.**
2. ~~Deploy the website gate~~ **DONE (web `main` `3ce7cf5`).**
3. Set the switch to `testers` and list the tester account ids (two data rows in `admin_config`); close again afterwards by deleting both rows.
4. Permission to approve test submissions publicly for minutes, then archive them.
5. Permission for real email to go to your own test buyer account (R8).
6. A new ordinary-member account created by you (or my creating it with your approval).

## 8. Genuine risks and blockers found

- **Not a blocker, but a real gap:** there is exactly **one** admin and no moderator. Moderation, approvals and contributor-change reviews all depend on one person. Consider adding a moderator account before opening (the database already lets moderators review; the website's admin pages currently allow admins only).
- Point-in-time recovery is still not enabled (daily backups only; the latest, 03:06 UTC on 7 Nov, is after the migrations).
- Real signed-in behaviour has only been proven against mocks and rolled-back database runs: that is exactly what Parts A to C close. No launch decision should be taken before they pass.
- Every other item found during preparation was fixed or is listed above; none is a launch blocker today.
