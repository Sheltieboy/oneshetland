/**
 * events-release-dryrun.node.test.ts — the dry-run assembler must make it IMPOSSIBLE to emit a dry run that persists anything.
 * Offline (reads files only; no database, no network). Run: node --test supabase/tests/events-release-dryrun.node.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, stripTransaction, verify, MIGRATIONS, TOKEN_KEYS } from '../../scripts/events-release-dryrun.mjs';

const ids: Record<string, string> = Object.fromEntries(TOKEN_KEYS.map((k, i) => [k, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));

test('the three real migrations assemble into ONE transaction ending in ROLLBACK, with no commit and every token resolved', () => {
  for (const minimal of [true, false]) {
    const sql = assemble({ ids, minimal });
    const lines = sql.split('\n');
    assert.equal(lines.filter((l) => /^begin;$/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /^rollback;$/.test(l)).length, 1);
    assert.equal(lines.filter((l) => l.trim()).at(-1), 'rollback;');
    assert.doesNotMatch(sql, /^\s*(commit|abort|savepoint)\b/im);
    assert.doesNotMatch(sql, /@@/);
    for (const f of MIGRATIONS) assert.ok(sql.includes(`t.before.${f.slice(0, 14)}`));
    assert.match(sql, /create table public\.event_occurrences/i, 'the real migration text is inside');
    assert.equal(/'t\d+\.\w+'/.test(sql), !minimal, 'behavioural checks only in the full run');
  }
});

test('the migration text is reproduced BYTE FOR BYTE (only its own begin;/commit; removed): $$ bodies and every other character survive', () => {
  const sql = assemble({ ids, minimal: true });
  for (const f of MIGRATIONS) {
    const stripped = stripTransaction(require_read(f), f);
    assert.ok(sql.includes(stripped), `${f}: the assembled SQL must contain the stripped migration unchanged`);
  }
  const dollars = (s: string) => (s.match(/\$\$/g) ?? []).length;
  assert.ok(dollars(sql) >= MIGRATIONS.reduce((n, f) => n + dollars(require_read(f)), 0), 'no $$ lost');
});

test('the migrations really do carry their own begin;/commit; (so stripping them is necessary), and it is stripped exactly', () => {
  for (const f of MIGRATIONS) {
    const raw = require_read(f);
    assert.equal((raw.match(/^begin;$/gm) ?? []).length, 1, f); assert.equal((raw.match(/^commit;$/gm) ?? []).length, 1, f);
    const stripped = stripTransaction(raw, f);
    assert.doesNotMatch(stripped, /^\s*(begin|commit)\s*;\s*$/im);
    assert.equal(stripped.split('\n').length, raw.split('\n').length - 2, 'only those two lines go');
  }
});

test('it refuses anything that could persist: a missing wrapper, a stray commit, a missing rollback, a second begin, unresolved tokens, missing timeouts', () => {
  assert.throws(() => stripTransaction('select 1;', 'x'), /exactly one/);
  assert.throws(() => stripTransaction('begin;\nbegin;\ncommit;', 'x'), /exactly one/);
  const good = assemble({ ids, minimal: true });
  assert.throws(() => verify(good.replace(/\nrollback;\n$/, '\ncommit;\n')), /rollback|forbidden/);
  assert.throws(() => verify(good.replace('select k, v from dr order by n;', 'commit;\nselect k, v from dr order by n;')), /forbidden/);
  assert.throws(() => verify(good.replace('select k, v from dr order by n;', 'savepoint a;\nselect k, v from dr order by n;')), /forbidden/);
  assert.throws(() => verify(good.replace(/^begin;/, 'begin;\nbegin;')), /exactly one begin/);
  assert.throws(() => verify(good + '@@LEFT@@'), /unresolved/);
  assert.throws(() => verify(good.replace("set local lock_timeout = '1500ms';", '')), /missing set local lock_timeout/);
  assert.throws(() => assemble({ ids: { ...ids, ADMIN_ID: 'not-a-uuid' } }), /needs a UUID/);
  assert.throws(() => assemble({ ids, read: (p: string) => (p.endsWith('20261230010000_event_member_submissions.sql') ? 'select 1;' : require_read_path(p)) }), /exactly one/);
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const MIGDIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
function require_read(f: string) { return readFileSync(join(MIGDIR, f), 'utf8'); }
function require_read_path(p: string) { return readFileSync(p, 'utf8'); }
