# Deploy: sync-council-jobs

Syncs Shetland public-sector vacancies (SIC via myjobscotland) into the Work
section. Apply always goes out to the official listing. Runs on a schedule.

## 1. Run the migration
Adds the aggregation columns to `jobs` (source/source_ref/source_label +
external_employer_*) and makes `employer_id` nullable.

```bash
supabase db push
```

## 2. Deploy the function (unauthenticated — it's cron-invoked)
```bash
supabase functions deploy sync-council-jobs --no-verify-jwt
```

## 3. Set a shared secret (so only the scheduler can trigger it)
```bash
supabase secrets set CRON_SECRET='<a-long-random-string>'
```

## 4. Test it safely — DRY RUN first (parses, never writes)
```bash
curl -s "https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/sync-council-jobs?dry=1" \
  -H "x-cron-secret: <same-secret>" | jq
```
Expect `{ results: [{ source: "myjobscotland", ok: true, dry: true, parsed: ~25, sample: [...] }] }`.
If `parsed` looks right, do a real run (drop `?dry=1`) and check the Work section.

## 5. Schedule it (pg_cron → net.http_post, same pattern as reminder-runner)
Run once in the SQL editor. Every 3 hours is plenty (jobs change a few times a
day; be polite to the source):

```sql
select cron.schedule(
  'sync-council-jobs',
  '17 */3 * * *',                       -- :17 past, every 3 hours (off the hour)
  $$
  select net.http_post(
    url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/sync-council-jobs',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', current_setting('app.settings.cron_secret', true)
    ),
    body    := '{}'::jsonb
  );
  $$
);
```
(Use whatever secret store reminder-runner already uses; the header just has to
match `CRON_SECRET`.)

To change the cadence later: `select cron.unschedule('sync-council-jobs');` then
re-run with a new schedule.

## Fail-safe behaviour
* If the fetch fails or the parser returns **0 jobs**, the run aborts and leaves
  existing rows untouched — a broken page never wipes the board.
* Upserts are keyed on `(source, source_ref)`; listings that drop off the feed
  are deleted (they carry no in-app applications, so it's clean).

## When it needs a tweak
It parses myjobscotland's HTML. If SIC's listings ever stop appearing, they've
likely restyled the page — the fix is in `parseMyJobScotland()` in `index.ts`.
The durable fix is a proper partner feed from myjobscotland/SIC; swap the
`parse` fn for a feed reader and nothing else changes.

## Adding NHS Shetland (JobTrain) later
Add one entry to `SOURCES` in `index.ts` with its own `parse()`. The
upsert/prune/fail-safe logic is shared.
