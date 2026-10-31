# Official notice imports — source assessment (31 Oct 2026)

**Every source is DISABLED.** The framework (migration `20261129040000`, `_shared/notice-import.ts`, `import-official-notices`) can collect from a source only after a platform administrator calls `admin_set_import_source_enabled(id, true, <how reuse was confirmed>)`. Nothing is scheduled: the hourly schedule is documentation in `supabase/deploy/notices-import-cron.sql`, not a migration. Imported notices are silent (never pushed) and are never essential.

Research below used public web search and ONE anonymous read-only GET of the Council's public RSS URL. No credentials, no login, nothing written.

| Source | What exists | Structured? | Reuse position | Verdict |
|---|---|---|---|---|
| **Shetland Islands Council** news and operational notes | `https://www.shetland.gov.uk/rss/news` — RSS 2.0 (Jadu CMS). Fetched 31 Oct 2026: HTTP 200, `text/xml`, 20 items, stable article links (`/news/article/<id>/<slug>`), items include road "Operational note" items and general news. The parser handled all 20 (valid titles, unique references, links on `www.shetland.gov.uk`, 67–197 character excerpts, no markup). | Yes | **Not confirmed.** No reuse licence was found. An excerpt-with-link is the conventional minimum, but written confirmation from the Council is needed before enabling. | **Best first candidate. Keep disabled until the Council confirms in writing.** Suggested configuration: id `sic_council`, label "Shetland Islands Council (Official Notices)", host `www.shetland.gov.uk`, category `public_services`, 7–14 day expiry, hourly. |
| **NHS Shetland** | No RSS/API found. NHS Scotland bodies generally reserve copyright and ask for permission beyond narrow private use. | No | Permission required | **Leave disabled.** Request a feed or written permission; until then NHS notices are published directly by a verified NHS Shetland publisher (Level 2). |
| **Ferries (Council)** | No API or machine-readable status. Disruption is published as web "Operational note" / "Ferries notice" articles and phone voice banks. | No (but see Council feed) | As Council | **No separate source.** Ferry notices that appear in the Council news feed are covered by that source; otherwise leave to direct publishing by the Council (Essential Alert when genuinely critical). |
| **SSEN (power cuts)** | Open data portal with a real-time outage dataset covering the SHEPD area (which includes Shetland): CC BY 4.0, "as needed" update frequency. Endpoint and response format NOT verified here. | Yes (to be verified) | CC BY 4.0 (attribution) | **Possible later**, but raw outage records (postcodes, counts) need an area-mapping and wording design, and are not suitable for automatic essential alerts. Keep disabled; design separately. |
| **Scottish Water** | No API found. | No | Unknown | **Leave disabled.** Ask for a feed; or have Scottish Water publish directly as a verified organisation. |
| **Transport operators (NorthLink, Loganair, bus)** | Not investigated beyond the above; no feed identified. | Unknown | Unknown | **Leave disabled.** |

## Honest limitations of the first candidate
* **Area.** The Council feed does not say which area an item concerns. The importer would publish with the source's configured default (`shetland_wide`), which overstates the reach of a local road notice. An area resolver using `place_aliases` is a sensible follow-up but is NOT built; it must never guess silently.
* **Expiry.** The feed carries no expiry; the source's `expiry_days` applies. A resolved road closure would linger until then unless the item is removed from the feed (then it is withdrawn on the next clean run).
* **Essential/urgent.** Never inferred. A road closure that is genuinely critical must be issued by the Council as an Essential Alert through the entitlement path, not by import.
* **Transition.** When the Council publishes directly, `admin_retire_import_source` disables the import for good and withdraws its live imported notices so nothing is shown twice.

## What approval requires (per source)
1. Written confirmation that OneShetland may show a short excerpt with a link and attribution.
2. `admin_upsert_import_source(...)` with the exact feed URL and the single allowed host.
3. `admin_set_import_source_enabled(id, true, '<how confirmed, who, when>')`.
4. A supervised first run (call the function with the cron secret and `{"source": "<id>"}`), then check `admin_import_status()` and the Notices page before installing the schedule.
