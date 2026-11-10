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

describe('the permission assertion actually detects an exposure (mutation controls)', () => {
  const foundation = join(DIR, 'editions-foundation.post-check.sql');
  const badRows = () => db.rawFile(foundation).split('\n').map((l) => l.trim()).filter((l) => l.endsWith('|f'));
  const target = `public.edition_org_contact_email(uuid)`;
  test('granting a private Editions function to anon fails the check; revoking it restores the pass', () => {
    assert.deepEqual(badRows(), []);
    db.raw(`grant execute on function ${target} to anon`);
    try { assert.ok(badRows().some((l) => /ONLY Editions functions anon can execute/.test(l)), 'the exposure must be reported'); }
    finally { db.raw(`revoke execute on function ${target} from anon`); }
    assert.deepEqual(badRows(), []);
  });
  test('a PUBLIC grant (inherited by anon) also fails the check', () => {
    db.raw(`grant execute on function ${target} to public`);
    try { assert.ok(badRows().length >= 1); } finally { db.raw(`revoke execute on function ${target} from public`); }
    assert.deepEqual(badRows(), []);
  });
});
