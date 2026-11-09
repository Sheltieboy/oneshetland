/**
 * editions-migration-reconcile.node.test.ts — pure (no database). Rehearses scripts/editions-migration-reconcile.mjs against SIMULATED production histories:
 * clean, an unexpected live-only version, an out-of-order pending migration, a hand-applied migration, foreign releases riding along, and the real branch.
 * Run: ISOLATED_ONLY=editions-migration-reconcile npm run test:isolated
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs
import { plan, listMigrations, releaseOf } from '../../scripts/editions-migration-reconcile.mjs';

const M = (v: string, name: string) => ({ version: v, file: `${v}_${name}.sql`, release: releaseOf(`${v}_${name}.sql`) });
const base = [M('20261001000000', 'a'), M('20261002000000', 'b')];
const editions = [M('20270102000000', 'editions_foundation'), M('20270102010000', 'editions_partners')];

describe('release classification', () => {
  test('names map to releases', () => {
    assert.equal(releaseOf('20270102000000_editions_foundation.sql'), 'editions');
    assert.equal(releaseOf('20261230110000_my_saved.sql'), 'my-saved');
    assert.equal(releaseOf('20261231000000_admin_intelligence.sql'), 'admin-intelligence');
    assert.equal(releaseOf('20270101000000_home_announcements.sql'), 'home-announcements');
    assert.equal(releaseOf('20261001000000_something_else.sql'), 'other');
  });
});

describe('simulated production histories', () => {
  test('clean: production has everything but the Editions migrations, which sort after it', () => {
    const r = plan([...base, ...editions], ['20261001000000', '20261002000000'], [], { only: 'editions' });
    assert.deepEqual(r.pending.map((p: any) => p.version), ['20270102000000', '20270102010000']);
    assert.equal(r.hazards.length, 0); assert.equal(r.safe_to_dry_run, true);
    assert.ok(r.commands.some((c: any) => /db push --linked --dry-run/.test(c.cmd) && /REQUIRED/.test(c.approval)), 'the dry run needs approval');
    assert.ok(r.commands.every((c: any) => !/^supabase db push --linked$/.test(c.cmd)), 'never emits a bare db push');
  });
  test('production has a version this branch lacks: flagged, never "repaired away"', () => {
    const r = plan([...base, ...editions], ['20261001000000', '20261002000000', '20261003000000'], [], { only: 'editions' });
    assert.deepEqual(r.live_only, ['20261003000000']);
    assert.ok(r.hazards.some((h: any) => h.code === 'LIVE_ONLY' && /Restore the exact files/.test(h.detail)));
    assert.ok(r.commands.every((c: any) => !/repair --status reverted/.test(c.cmd)));
  });
  test('a pending migration older than production\'s newest is an ordering hazard', () => {
    const r = plan([...base, M('20261001500000', 'late'), ...editions], ['20261001000000', '20261002000000'], [], { only: 'editions' });
    assert.ok(r.out_of_order.includes('20261001500000'));
    assert.ok(r.hazards.some((h: any) => h.code === 'OUT_OF_ORDER'));
  });
  test('a hand-applied migration gets a register-not-reapply command, with approval', () => {
    const r = plan([...base, ...editions], ['20261001000000', '20261002000000'], ['20270102000000'], { only: 'editions' });
    assert.ok(r.hazards.some((h: any) => h.code === 'HAND_APPLIED'));
    const c = r.commands.find((x: any) => /repair --status applied 20270102000000/.test(x.cmd));
    assert.ok(c && /REQUIRED/.test(c.approval));
  });
  test('other releases riding on the branch are flagged and a release-branch command with ONLY the Editions files is produced', () => {
    const other = [M('20261230110000', 'my_saved'), M('20261231000000', 'admin_intelligence')];
    const r = plan([...base, ...other, ...editions], ['20261001000000', '20261002000000'], [], { only: 'editions' });
    assert.ok(r.hazards.some((h: any) => h.code === 'FOREIGN_RELEASES'));
    const sw = r.commands.find((c: any) => /git switch -c editions-release origin\/main/.test(c.cmd));
    assert.ok(sw && /editions_foundation/.test(sw.cmd) && !/my_saved|admin_intelligence/.test(sw.cmd));
    assert.equal(r.safe_to_dry_run, false);
  });
  test('an unrecognised pending migration is flagged rather than silently shipped', () => {
    const r = plan([...base, M('20261003000000', 'mystery'), ...editions], ['20261001000000', '20261002000000'], [], { only: 'editions' });
    assert.ok(r.hazards.some((h: any) => h.code === 'UNKNOWN_RELEASE' && /mystery/.test(h.detail)));
  });
});

describe('listMigrations reads a real directory', () => {
  test('sorted, versions are 14 digits, files are classified', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'));
    for (const f of ['20270102010000_editions_partners.sql', '20270102000000_editions_foundation.sql', 'README.md']) writeFileSync(join(d, f), '-- x');
    const l = listMigrations(d);
    assert.deepEqual(l.map((m: any) => m.version), ['20270102000000', '20270102010000']);
    assert.ok(l.every((m: any) => m.release === 'editions'));
    assert.equal(readdirSync(d).length, 3);
  });
});
