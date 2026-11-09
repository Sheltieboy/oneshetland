/**
 * editions-post-checks.node.test.ts — ISOLATED Postgres only. The production post-check SQL files are what Darren runs after applying each migration, so each one must itself be
 * correct: this replays the REAL migrations into a throwaway database and runs every Editions post-check, failing on any SQL error or any row that is not ok = true.
 * Run: ISOLATED_ONLY=editions-post-checks npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../production/post-checks');
let db: ReplayDb;
before(() => { db = createReplayDb('editionspostchecks'); });
after(() => { try { db?.drop(); } catch { /* */ } });

describe('every Editions post-check passes on a freshly replayed database', () => {
  const files = readdirSync(DIR).filter((f) => /^editions-.*\.post-check\.sql$/.test(f)).sort();
  test('there is a post-check for each release step', () => {
    for (const must of ['foundation', 'partners', 'commerce', 'branding', 'hardening', 'update-images', 'stage-a', 'stripe-lifecycle']) assert.ok(files.some((f) => f.includes(must)), `missing post-check: ${must}`);
  });
  for (const f of files) {
    test(f, () => {
      const out = db.rawFile(join(DIR, f));
      assert.doesNotMatch(out, /ERROR|syntax error/i, `${f} raised an SQL error:\n${out.slice(0, 600)}`);
      const rows = out.split('\n').map((l) => l.trim()).filter((l) => /\|[tf]$/.test(l));
      assert.ok(rows.length > 0, `${f} printed no check rows`);
      const bad = rows.filter((l) => l.endsWith('|f'));
      assert.deepEqual(bad, [], `${f} has failing checks`);
    });
  }
});
