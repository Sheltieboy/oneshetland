# Notices & Alerts — backend contract for the app and website

Status: LOCAL ONLY. None of this is applied to production, deployed or pushed. Migrations: `supabase/migrations/20261129000000` … `20261129040000`.
`get_funeral_notice(p_id)` now finds any published notice (not just the 50 newest). The demo proxy now forwards `areas` and allows the read-only `get_public_notice` / `my_official_publishers`.
Everything below is proven by the isolated-Postgres suites `supabase/tests/notices-alerts-{core,audience,funeral,imports}.node.test.ts` (80 tests).

## The model in one page

| Level | Name | Definition (server-decided) | Prominence |
|---|---|---|---|
| 1 | Essential Alert | `notices.is_essential` AND published, started, unexpired, not hidden, before `review_at`, organisation verified+active+still holds the grant | the ONE reserved top slot |
| 2 | Health & Official | published notice from an official source (`source` set: an import) or a verified organisation (`official_publisher_id` set) that is not an active essential alert | standard card, "Issued by / Source:" byline |
| 3 | Community | everything else: hub, business, person (approved), OneShetland | standard card |
| — | Deaths & Funeral | separate table `funeral_notices`; never a row in `notices`, never Level 1 | its own tab and template |

Priority, publisher authority and notification permission are separate. `can_publish_urgent` (old, per-business) is NOT the essential permission.

## Public reads (callable by anon; no auth needed)

All return only publicly visible rows. Pass `p_area_ids`: **null = unfiltered; `[]` = Shetland-wide notices only; `['voe', …]` = those areas, anything inside them, any area containing them, plus Shetland-wide. THREE area states are distinct: specific areas; explicit Shetland-wide (a `shetland_wide` row); UNSPECIFIED (no rows - hubs and businesses cannot choose one). An unspecified notice appears in general browsing (any filter that names areas) but NOT in the strict `[]` ("Shetland-wide only") filter, carries no geography label, and is never an area-based push audience.**
The Shetland-wide root (`shetland_wide`) is never a member area.

* `get_essential_alerts(p_area_ids text[] default null)` → rows `{id,title,body,action_text,category,published_at,expires_at,review_at,link_url,publisher,area_ids,area_names}`. ONLY active essential alerts. Empty array = render nothing and leave no gap.
* `get_public_notices(p_level text default 'all', p_area_ids text[] default null, p_category text default null, p_limit int default 20, p_offset int default 0)`
  `p_level` ∈ `all | essential | official | community`. Rows: `{id,title,body,action_text,severity,category,category_label,published_at,starts_at,expires_at,review_at,link_url,level,is_essential_active,publisher,area_ids,area_names,publisher_hub_id,publisher_business_id,event_id,campaign_id,image_url,publisher_logo_url,publisher_brand_color,hub_slug,business_slug}`.
  `level` is an INTEGER: 1 essential, 2 official, 3 community. Order: active essential first, then pinned, then newest. `limit` is clamped to 50.
  `publisher` is the authoritative attribution object `{kind,label,is_official_source,source_label,source_url,byline}`; `kind` ∈ `hub|business|person|platform|official`. **Use `publisher.label`/`byline`; never infer identity from joins.** `official` = a verified organisation ("Issued by …"); `platform` with `is_official_source=true` = an import ("Source: …"). Person names are only ever released for currently-public notices; the label is already privacy-safe ("A OneShetland member", "Former member").
* `get_public_notice(p_id uuid)` → the same row shape as `get_public_notices`, for exactly one PUBLIC notice (empty for anything resolved, scheduled, hidden, withdrawn or unknown). Use it for detail pages and deep links instead of scanning a list.
* `get_funeral_notices(p_area_ids text[] default null, p_limit int default 20, p_offset int default 0)` and `get_funeral_notice(p_id uuid)` → `{id,full_name,preferred_name,photo_url,born_on,died_on,announcement,service_kind,service_venue,service_at,service_notes,family_requests,donation_info,donation_url,area_id,area_name,published_at}`. Arrangement fields are null unless the family approved publishing them. No contact/verification data is ever returned. A notice with no area appears under every area filter.

## Signed-in (authenticated) functions

Member preferences — **areas never imply consent; every audience is default OFF**
* `my_notice_areas()` → `text[]`; `set_my_notice_areas(p_areas text[])` → `text[]` (physical areas only, max 12, replaces the set; `shetland_wide` is refused).
* `my_notice_prefs()` → `{essential_alerts, official_notices, community_notices, community_categories (null = all), funeral_notices}`;
  `set_my_notice_prefs(p_essential, p_official, p_community, p_categories, p_funeral, p_all_community_categories)` — every argument optional (null = unchanged).
* A member with no areas receives Shetland-wide notices only (never "everything"). Push also depends on the existing master switch, the `notices` module toggle and quiet hours (the sender applies them); in-app browsing always works without push.

Publishing as a verified organisation (web only)
* `my_official_publishers()` → `{publisher_id,slug,name,kind,role,can_publish,can_essential}`. Empty for ordinary users: hide the publisher UI.
* `official_publish_notice(p_publisher, p_title, p_body, p_category, p_area_ids, p_expires_at, p_starts_at, p_link_url, p_action_text, p_is_essential, p_review_at)` → id. Essential rules (the server enforces all; mirror them in the form for guidance only): title 5–120, body 20–4000, action text 10–500, ≥1 area (or `shetland_wide` alone), expiry after start and ≤ 7 days from start, `review_at` between start and expiry, link plain `https`. Non-essential official notices need an expiry ≤ 180 days. A delegate cannot mark essential; neither can an organisation without the live grant.
* `my_official_notices(p_publisher uuid)` (authenticated; members of that organisation and administrators only) → `{id,title,body,status,severity,is_essential,category,starts_at,expires_at,review_at,published_at,action_text,link_url,area_ids,announced}` in EVERY state (scheduled, resolved, withdrawn included). `announced` = a notification dispatch has completed (hide the notify button).
Members' own notices (moderated; migration 20261129050000 and the core migration)
* `submit_person_notice(p_title, p_body, p_category, p_area_ids text[] default '{}', p_expires_at default null)` → id. Title 5–120, text 10–2000, a listed category, areas = `['shetland_wide']` alone OR up to 8 physical areas (an empty array is allowed by the API and means UNSPECIFIED; the website and app forms never send it), expiry future and ≤ 90 days (blank = 30 days). The notice is pending, theirs, never urgent / essential / hub / business / platform / event. At most 5 awaiting review.
* `my_person_notices()` → the caller's own notices in every state: `state` is `pending | published | expired | withdrawn | declined | resolved`, with `decline_reason`, `can_edit`, `can_withdraw`, `area_ids`, `area_names`.
* `edit_my_person_notice(p_notice, p_title, p_body, p_category, p_area_ids, p_expires_at)` (NULL = keep; `[]` clears the areas) — pending or published, not expired; returns the notice to pending and out of every public read until staff approve it again. Editing through the table is impossible by design (Postgres refuses an UPDATE whose new row the author cannot read).
* `withdraw_my_person_notice(p_notice)`; staff (`attribution_staff`): `staff_pending_person_notices()`, `staff_approve_person_notice(p_notice)`, `staff_decline_person_notice(p_notice, p_reason)` (the reason is shown to the member). All five change events are in `notice_audit_log`. Person notices are never announced by push (`notice_dispatchable` refuses them).
* `official_update_notice(p_notice, …)` (null = keep), `official_set_notice_status(p_notice, 'resolved'|'withdrawn')`. Editing never sends a notification.
* Notifications for an alert are a SEPARATE, explicit, once-only request: `POST /functions/v1/notify-notice-audience {notice_id, kind}` (edge function, not deployed). Never offer "notify again".

Funeral notices
* `submit_funeral_notice(p jsonb)` → id. Required: `full_name`, `submitter_name`, a phone or email (private), `family_authorised: true`. Everything else optional: `preferred_name, photo_url (https), born_on, died_on, announcement (≤1500, no links), service_public, service_kind (funeral|burial|cremation|memorial|private), service_venue, service_at, service_notes, family_requests, donation_info, donation_url (https), area_id, announce_in_notifications, announce_name_in_preview, submitter_relationship, submitter_role ('family'|'funeral_director')`. Nothing is public until staff verify.
* `my_funeral_submission(p_id)` → jsonb of the submitter's OWN editable fields (pre-fills the edit form; `review_message` is the staff message for `needs_info` AND `rejected`). `my_funeral_submissions()`, `update_my_funeral_submission(p_id, p jsonb)` (only while submitted/needs_info), `withdraw_my_funeral_notice(p_id)`, `request_funeral_notice_change(p_id, 'correction'|'takedown', p_message, p_contact)`.

Platform administration (administrators; moderators for funeral/person review only — the functions enforce it)
* Organisations & entitlement: `admin_list_official_publishers()`, `admin_upsert_official_publisher`, `admin_verify_official_publisher(id, note)`, `admin_set_official_publisher_active`, `admin_set_official_publisher_member(pub, user, role, active)`, `admin_list_official_publisher_members(pub)`, `admin_grant_essential_alert(pub, reason)`, `admin_revoke_essential_alert(pub, reason)` (demotes live alerts), `admin_notice_audit(limit, before)`, `admin_notice_dispatch_history(notice)`.
* Funeral moderation: `admin_funeral_queue(status)`, `admin_funeral_review(id, action, note, verification_method)` with actions `start_review|request_info|approve|reject` (approve REQUIRES a method and a note), `admin_funeral_takedown(id, reason)`, `admin_funeral_change_requests()`, `admin_funeral_resolve_change(request, 'actioned'|'declined', note, correction jsonb)`, `admin_set_funeral_director(name, user, verify)`.
* Imports: `admin_import_status()`, `admin_upsert_import_source`, `admin_set_import_source_enabled(id, enabled, reuse_note)`, `admin_retire_import_source`.
* Existing and unchanged: `manage_notices`, `manage_set_notice_status`, `manage_delete_notice`, the `notices` table policies, and the deployed `notify-community-notice` (admin island-wide broadcast, which keeps its approved quiet-hours bypass).

## Presentation rules (decided)

* **Essential slot:** only `get_essential_alerts` content. Collapse completely when empty. Existing `partner_alerts` (business-sourced strip) must NOT use the essential/emergency treatment or position; render it, if kept, as a calm, small "Update from <business>" line lower on the page. One coherent precedence: Essential Alert (top, red) → nothing else competes for that position.
* **Homepage notices:** equal-sized cards (same height/width grid, 1 column on phones, 2–3 on desktop), at most 6, newest first from `get_public_notices('all')` EXCLUDING active essential alerts (they live in the slot). Each card: publisher/source line, category label, title, short body (clamped), area names (first two + "+N"), relative or dated time, and a destination when one exists. A "View all notices" link to the Notices page. No giant first card.
* **Notices page:** filters All / Essential alerts / Health & official / Community / Deaths & funeral, plus an area filter (and "My areas" for signed-in members with areas). Full content readable. Pagination with "Show more". Notices without a destination are plain blocks (no navigation to unrelated sections). Source links only when `publisher.source_url` is a valid https URL.
* **Funeral template:** quiet, traditional shop-window / newspaper-announcement feel: serif display for the name, ornamental rule, generous spacing, restrained palette (warm parchment / deep slate / muted burgundy), NO emergency colours, no promotion, no gamification, no animation. Optional photograph as a small oval portrait. Service details only when present. Respect `prefers-reduced-motion`; accessible contrast.
* **UK English** throughout. Existing OneShetland tokens, spacing and components. Do not redesign unrelated screens.

## Demonstration environment (local, fictional)

* Backend: `http://192.168.0.245:54790` — read-only, anonymous-only proxy over a fixture database that has all five migrations and the fixtures in `supabase/tests/api/ui-*fixtures.sql`. Start/stop: `PROXY_HOST=<ip> DEMO_LAN=1 bash supabase/tests/api/ui-fixture-env.sh start|stop` (run from the worktree that owns the script). Signed-in and write flows cannot be exercised against it (it refuses auth and writes): test those with mocked clients and unit tests, and say so plainly.
* Demo content: 3 active essential alerts (road closure Voe/Brae/Delting; power cut Hillswick/Northmavine; ferry suspension Yell/Unst/Fetlar), a scheduled alert (Lerwick water, starts in 6 h — must NOT show), a resolved alert (must NOT show), 2 official notices (Council bins; NHS flu clinics), imports, hub / business / person / platform notices, 3 published funeral notices (Voe, Lerwick, Scalloway — the third keeps arrangements private) and one awaiting review.
* Known areas for tests: `voe`, `brae`, `delting`, `hillswick`, `northmavine`, `lerwick`, `scalloway`, `yell_unst_fetlar`, `shetland_north`, `shetland_central`.

## Rules for everyone building on this

Local work only; commit in logical commits with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not push, merge, deploy, apply migrations, call production, send anything, or run suites that write to production (never `npm test`, never `node --test` on a directory, never anything using `service_key.txt` or `--linked`). Never display secrets.
