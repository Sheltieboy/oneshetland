/**
 * social-autopilot-and-pause.node.test.ts — Peerie Press launch Phase 1:
 * wiring the existing `social_recipes.autopilot` column, and a global
 * publisher pause.
 *
 * WHAT CHANGED
 *
 * social-composer: every recipe's insert now carries `status: statusFor(key)`
 * — 'draft' when the recipe's autopilot is off (unchanged default), or
 * 'scheduled' when it's on. 'scheduled' already existed in the status CHECK
 * constraint and was already treated identically to 'approved' by the
 * publisher's due-post query and the admin UI's queue view — it was simply
 * never written by anything until now. Nothing about scheduling, dedupe,
 * max_per_run, image/caption generation, or the publisher's own selection
 * logic changed.
 *
 * social-publisher: a new global pause, read from
 * admin_config['social.publishing_paused'] via the existing getConfig()
 * helper. When 'true', the function returns before selecting any due post or
 * making any Meta API call — no row is read, let alone written. The
 * stale-post guard, max-per-run cap, and failed-post recording are otherwise
 * byte-for-byte unchanged.
 *
 * SAFETY
 * Source-level assertions only, plus one read-only check that the migration
 * seeded the pause row. No edge function is invoked, no network call to Meta
 * is made, nothing is posted.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const composer  = code(read('supabase/functions/social-composer/index.ts'));
const publisher = code(read('supabase/functions/social-publisher/index.ts'));
const actions   = code(readFileSync(join(REPO_ROOT, '..', 'oneshetland-web', 'lib', 'social-actions.ts'), 'utf8'));
const studio    = code(readFileSync(join(REPO_ROOT, '..', 'oneshetland-web', 'components', 'admin', 'SocialStudio.tsx'), 'utf8'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));

const RECIPES = ['wird_of_day', 'whats_on_roundup', 'jobs_roundup', 'new_product', 'event_spotlight'];

/* ── 1. enabled=false → no post composed (pre-existing, must still hold) ─── */

describe('enabled=false still composes nothing', () => {
  test('every recipe insert is still gated behind its own enabled(...) check', () => {
    for (const key of RECIPES) {
      const gate = new RegExp(`if \\(enabled\\('${key}'\\)\\)`);
      assert.match(composer, gate, `${key} must still be gated on enabled('${key}')`);
    }
  });
});

/* ── 2 & 3. status derivation ────────────────────────────────────────────── */

describe('autopilot decides draft vs scheduled, nothing else', () => {
  test('statusFor maps false→draft, true→scheduled, off the recipe row — not invented elsewhere', () => {
    assert.match(composer, /const statusFor = \(k: string\)[\s\S]{0,40}=>[\s\S]{0,40}autopilot === true \? 'scheduled' : 'draft'/);
  });

  test('every recipe insert now sets status via statusFor, using its own key', () => {
    for (const key of RECIPES) {
      const re = new RegExp(`status: statusFor\\('${key}'\\),`);
      assert.match(composer, re, `${key} insert must set status: statusFor('${key}')`);
    }
  });

  test('scheduled_for is still computed independently — autopilot does not bypass scheduling', () => {
    // jitter(nextLondonHour(...)) must still appear once per recipe, unchanged
    // in shape, alongside (not instead of) the new status field.
    const jitterCalls = composer.match(/scheduled_for: jitter\(nextLondonHour\(/g) ?? [];
    assert.equal(jitterCalls.length, RECIPES.length, 'every recipe must still compute scheduled_for the same way');
  });

  test('the Recipe type carries autopilot from the row, not a guess', () => {
    assert.match(composer, /type Recipe = \{ key: string; enabled: boolean; autopilot: boolean; config: Record<string, unknown> \}/);
  });
});

/* ── 4 & 5. global pause ───────────────────────────────────────────────────── */

describe('global pause stops the publisher before it can reach Meta', () => {
  test('paused is read via the existing getConfig() helper, not invented storage', () => {
    assert.match(publisher, /import \{ getConfig \} from '\.\.\/_shared\/admin-config\.ts'/);
    assert.match(publisher, /getConfig\(svc, 'social\.publishing_paused', 'false'\)/);
  });

  test('the pause check returns before any due-post selection or Meta call', () => {
    const pauseIdx  = publisher.indexOf("getConfig(svc, 'social.publishing_paused'");
    const dueIdx    = publisher.indexOf('let due: PostRow[]');
    const graphIdx  = publisher.indexOf('postToFacebook(pageId, token, post)');
    assert.notEqual(pauseIdx, -1, 'pause check must exist');
    assert.ok(pauseIdx < dueIdx, 'pause check must run before due posts are ever selected');
    assert.ok(pauseIdx < graphIdx, 'pause check must run before any Meta API call in the file');
  });

  test('paused returns without querying or mutating any post row', () => {
    const block = publisher.slice(publisher.indexOf("const paused ="), publisher.indexOf('const now = new Date()'));
    assert.match(block, /if \(paused\) \{\s*return json\(/, 'paused must short-circuit with an early return');
    assert.doesNotMatch(block, /\.from\('social_posts'\)/, 'the paused branch must not touch social_posts at all');
  });

  test('the manual post_id override is also inside the pause guard, not a bypass', () => {
    const pauseIdx   = publisher.indexOf("getConfig(svc, 'social.publishing_paused'");
    const onlyPostIdx = publisher.indexOf('if (onlyPostId) {');
    assert.ok(pauseIdx < onlyPostIdx, 'the manual post_id path must also be gated behind the pause check');
  });

  test('default (missing config row) is unpaused — additive only, never more restrictive by accident', () => {
    assert.match(publisher, /getConfig\(svc, 'social\.publishing_paused', 'false'\)/,
      "fallback must be the string 'false' so an unmigrated environment behaves exactly as before");
  });
});

describe('unpause resumes exactly the pre-existing selection logic', () => {
  test('the due-post query is unchanged below the pause check', () => {
    assert.match(publisher, /\.from\('social_posts'\)\.select\('\*'\)\s*\.eq\('id', onlyPostId\)/);
    assert.match(publisher, /\.in\('status', \['approved', 'scheduled'\]\)/);
    assert.match(publisher, /\.or\(`scheduled_for\.is\.null,scheduled_for\.lte\.\$\{nowIso\}`\)/);
  });
});

/* ── 6, 7, 8, 9. everything else must be byte-for-byte unchanged ─────────── */

describe('dedupe, caps, staleness and failure handling are untouched', () => {
  test('dedupe: the unique (kind, entity_id) doneIds pattern is still used per recipe', () => {
    assert.match(composer, /kind', 'new_product'\)\.limit\(5000\)/);
    assert.match(composer, /kind', 'event_spotlight'\)\.limit\(5000\)/);
    assert.match(composer, /doneIds\.has\(/);
  });

  test('max_per_run: publisher MAX_PER_RUN and per-recipe maxPerRun caps still present', () => {
    assert.match(publisher, /const MAX_PER_RUN = 5;/);
    assert.match(composer, /const maxPerRun = Number\(cfg\('new_product'\)\.max_per_run \?\? 2\)/);
    assert.match(composer, /const maxPerRun = Number\(cfg\('event_spotlight'\)\.max_per_run \?\? 2\)/);
  });

  test('stale-post guard: still 48h, still marks skipped rather than posting, still exempts manual post_id', () => {
    assert.match(publisher, /const STALE_HOURS = 48;/);
    assert.match(publisher, /if \(!onlyPostId && post\.scheduled_for &&/);
    assert.match(publisher, /status: 'skipped', error: `stale: scheduled_for more than \$\{STALE_HOURS\}h ago`/);
  });

  test('failed-post recording: still writes status failed + error message, still per-post try/catch', () => {
    assert.match(publisher, /status: 'failed', error: msg/);
  });
});

/* ── 10. manual approval workflow is unaffected when autopilot=false ─────── */

describe('the existing manual approval workflow is unchanged for autopilot=false recipes', () => {
  test('approveSocialPost still exists, unchanged in shape', () => {
    assert.match(actions, /export async function approveSocialPost\(id: string, caption: string, scheduledFor: string \| null\)/);
    assert.match(actions, /status: "approved", error: null/);
  });

  test('a draft-status post (autopilot off) still requires this same approve action to become publisher-eligible', () => {
    // The publisher's own selection query never includes 'draft' in the
    // unconditional (non-post_id) path — proven above — so nothing besides
    // an explicit admin approve/revert action can move a draft forward.
    assert.match(publisher, /\.in\('status', \['approved', 'scheduled'\]\)/);
  });

  test('autopilot is a distinct control from enabled, on both the action layer and the admin UI', () => {
    assert.match(actions, /export async function toggleSocialRecipeAutopilot\(key: string, autopilot: boolean\)/);
    assert.match(actions, /export async function toggleSocialRecipe\(key: string, enabled: boolean\)/);
    assert.match(studio, /label="Enabled"/);
    assert.match(studio, /label="Autopilot"/);
  });

  test('the admin UI exposes the global pause with an obvious ACTIVE/PAUSED state', () => {
    assert.match(studio, /Social publishing: \{paused \? "PAUSED" : "ACTIVE"\}/);
  });
});

/* ── Migration applied (read-only check against the linked project) ──────── */

describe('the pause config row exists in production, defaulted safe', () => {
  test('social.publishing_paused is seeded, and is NOT itself a secret', () => {
    const r = runSql(`select value, is_secret::text from public.admin_config where key = 'social.publishing_paused'`)[0];
    if (!r) { throw new Error('migration not yet applied — expected admin_config row is missing'); }
    assert.equal(r.is_secret, 'false');
    assert.ok(r.value === 'true' || r.value === 'false', `value must be a boolean-ish string, got ${JSON.stringify(r.value)}`);
  });
});
