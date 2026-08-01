# Deploy: the social seeding engine ("Peerie Press") — Phase 1

Turns platform activity into branded Facebook posts, automatically:

```
recipes (social-composer) → social_posts queue → review at /admin/social
                                               → social-publisher → Facebook Page
```

Everything the composer creates is a **draft** — nothing reaches Facebook until
you approve it in the admin queue. Cards are rendered on demand by the website
(`https://oneshetland.com/api/social-image?...`) so no images are ever designed
by hand.

## 1. Run the migration
Creates `social_posts` (the queue + delivery log) and `social_recipes`
(per-recipe switches), seeds the three Phase-1 recipes.

```bash
supabase db push
```

## 2. Deploy the two functions (unauthenticated — cron-invoked)
```bash
supabase functions deploy social-composer --no-verify-jwt
supabase functions deploy social-publisher --no-verify-jwt
```

## 3. Secrets
`CRON_SECRET` is already set (reminder-runner / sync-council-jobs use it).

Optional, for Peerie Bot caption polish (falls back to plain templates without it):
```bash
supabase secrets set ANTHROPIC_API_KEY='sk-ant-…'
```

Facebook — needed before anything actually posts. Until these are set the
publisher is a safe no-op that just reports how many posts are waiting:
```bash
supabase secrets set META_PAGE_ID='<your Facebook Page id>'
supabase secrets set META_PAGE_TOKEN='<long-lived Page access token>'
```

### Getting the Page token (one-time, ~10 min)
1. Create the **OneShetland Facebook Page** (and later link an Instagram
   Business account to it for Phase 2).
2. Go to https://developers.facebook.com → create an app (type: Business).
3. In **Graph API Explorer**: pick your app → "Get Page Access Token" → select
   the OneShetland page → grant `pages_manage_posts` + `pages_read_engagement`.
4. Exchange it for a long-lived token (Graph API Explorer → the ⓘ next to the
   token → "Open in Access Token Tool" → "Extend Access Token"). Long-lived
   **Page** tokens obtained this way do not expire.
5. The Page id is on the Page's "About" screen (or returned by `/me/accounts`).

Posting to your **own** page with your own app needs no Meta app review.

## 4. Test the composer (creates drafts only — safe)
```bash
curl -s "https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/social-composer" \
  -H "x-cron-secret: <secret>" -H "Content-Type: application/json" \
  -d '{"force": true}' | jq
```
`force: true` bypasses the Monday-only gate on the roundup so you can see all
three recipes fire. Then open **/admin/social** — you should see drafts with
their branded cards. Approve one and run the publisher:

```bash
curl -s "https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/social-publisher" \
  -H "x-cron-secret: <secret>" | jq
```
Without Meta secrets: `{ ok: true, configured: false, due: N }`. With them: the
approved post appears on the Facebook Page and its row flips to `posted`.

## 5. Schedule both (pg_cron → net.http_post, same pattern as reminder-runner)
Run once in the SQL editor:

```sql
-- Composer: daily at 05:40 UTC (drafts the day's posts before you're up)
select cron.schedule(
  'social-composer', '40 5 * * *',
  $$
  select net.http_post(
    url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/social-composer',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', current_setting('app.settings.cron_secret', true)
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Publisher: every 15 min (only ever touches posts you've approved)
select cron.schedule(
  'social-publisher', '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/social-publisher',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', current_setting('app.settings.cron_secret', true)
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

## Behaviour & guardrails
* **Nothing auto-publishes.** Composer output is always `draft`; only rows you
  approve (status `approved`/`scheduled`) are picked up. The `autopilot` column
  on `social_recipes` is reserved for Phase 2.
* **No duplicates, ever** — unique `(kind, entity_id)`: a word, event or week
  can only be queued once, no matter how often the composer runs.
* **No stale floods** — approved posts whose schedule passed >48h ago are
  marked `skipped`, not posted (a paused pipeline can't spam on wake-up).
* **≤5 posts per publisher run**, oldest first.
* Recipes are switchable per-recipe in /admin/social (Recipes tab).

## Phase 2 (already accommodated)
Instagram (`channels` is multi-channel; IG needs the image URL flow it already
has), autopilot per recipe, offer roundups / business spotlights / ship-day
recipes, tier slot ledger.
