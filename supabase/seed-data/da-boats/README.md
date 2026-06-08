# Da Boats — seed data import

Apply migration 042 first, then import the CSVs below **in this order** via
Supabase dashboard → **Table Editor** → select the table → **Import data
from CSV**.

The Supabase SQL Editor doesn't support `\copy`, so the dashboard import
UI is the path of least resistance. Each file is small enough to upload
in one go.

| # | File                          | Table                  |
|---|-------------------------------|------------------------|
| 1 | `source_documents.csv`        | `source_documents`     |
| 2 | `source_records.csv`          | `source_records`       |
| 3 | `media_assets.csv`            | `media_assets`         |
| 4 | `vessels.csv`                 | `vessels`              |
| 5 | `vessel_source_links.csv`     | `vessel_source_links`  |
| 6 | `vessel_names.csv`            | `vessel_names`         |
| 7 | `registrations.csv`           | `registrations`        |
| 8 | `owners.csv`                  | `owners`               |
| 9 | `ownership_periods.csv`       | `ownership_periods`    |
| 10 | `vessel_events.csv`          | `vessel_events`        |
| 11 | `measurements.csv`           | `measurements`         |
| 12 | `vessel_relationships.csv`   | `vessel_relationships` |
| 13 | `vessel_media_links.csv`     | `vessel_media_links`   |

After import, hit `supabase migration repair --status applied 042`.

Coverage (per Codex `package_summary.json`):
- 6 source documents
- 2,714 source records
- 369 media assets
- 467 vessels
- 3,108 vessel names
- 3,136 registrations
- 36 owners, 77 ownership periods
- 2,639 vessel events
- 2,542 measurements
- 515 vessel→media links
