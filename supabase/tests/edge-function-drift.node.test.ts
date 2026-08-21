/**
 * edge-function-drift.node.test.ts — nothing runs in production that git
 * cannot account for.
 *
 * WHY THIS TEST EXISTS
 *
 * Four Edge Functions were deployed and ACTIVE in production with no source in
 * this repository: alert-addon-intent, analytics-addon-intent, expire-requests
 * and sync-business-addons. Their code could not be audited, their
 * authentication could not be reproduced, and a fresh project could not have
 * recreated them.
 *
 * They were not mysterious in the end. Three were deleted from git deliberately
 * in cb68afb, the tier collapse of 16 Aug 2026 — "Add-ons are abolished" — and
 * the deployments were simply never cleaned up. Downloading the live bundles
 * confirmed it: byte-identical to the git source at cb68afb^. The fourth,
 * expire-requests, had never been in this repository at all, and its logic
 * already lives inside reminder-runner.
 *
 * WHAT THE LEFTOVER ACTUALLY COST
 *
 * expire-requests answered HTTP 200 to a request carrying nothing but the
 * PUBLIC anon key. verify_jwt=true accepts the anon key as a valid JWT — it is
 * one — and that handler had no check of its own, so it went straight to a
 * service-role client, mutated delivery_requests and sent push notifications.
 * Anybody who read the website bundle could have run it.
 *
 * The other two were live Stripe subscription endpoints for add-ons that the
 * tier collapse had already made free: still able to charge a business £10 a
 * month for something its tier now included.
 *
 * All four are deleted. This test is what stops the situation returning.
 *
 * THE INVARIANT IS ONE-DIRECTIONAL, ON PURPOSE
 *
 * DEPLOYED → SOURCE MUST EXIST is mandatory: anything serving production
 * traffic has to be auditable.
 *
 * SOURCE → DEPLOYED is not. A directory may legitimately be work in progress,
 * or archived. That direction is reported rather than failed, so it prompts a
 * look without blocking ordinary work.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const FUNCTIONS_DIR = join(REPO_ROOT, 'supabase', 'functions');
const PROJECT_REF = 'nkrtmakxygkvxuxriiil';

/**
 * Deployed functions that are deliberately allowed to have no source here.
 * Empty, and it should stay empty: an entry means production is running code
 * this repository cannot show you.
 */
const DEPLOYED_WITHOUT_SOURCE_ALLOWED: string[] = [];

/**
 * Source directories deliberately not deployed. Also empty today. Adding one is
 * a normal thing to do — the test names it so the choice is visible.
 */
const SOURCE_ONLY_ALLOWED: string[] = [];

/** Removed in Step 10D. These must not come back without a deliberate decision. */
const DELETED_IN_10D = [
  'alert-addon-intent', 'analytics-addon-intent', 'expire-requests', 'sync-business-addons',
];

function localFunctions(): string[] {
  return readdirSync(FUNCTIONS_DIR)
    .filter((d) => !d.startsWith('_') && !d.endsWith('.md'))
    .filter((d) => { try { return statSync(join(FUNCTIONS_DIR, d)).isDirectory(); } catch { return false; } })
    .sort();
}

function runSql(sql: string): Record<string, unknown>[] {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) throw new Error(`db query error: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  return parsed.rows ?? [];
}

/**
 * Searches VERSION-CONTROLLED source only, by asking git for the file list
 * rather than walking the tree.
 *
 * Walking found two hits that look alarming and are not: a stale Expo build
 * under dist/ from before the tier collapse, and an old worktree under
 * .claude/. Both are gitignored build/tooling output, neither is source, and
 * excluding directories by name would have to be maintained forever. What
 * matters is what is committed, so that is what is asked.
 */
function trackedMatches(pattern: RegExp, roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js', '*.sql'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n').filter(Boolean);
    } catch { continue; }
    for (const rel of files) {
      if (rel.includes('edge-function-drift.node.test')) continue;
      let body = '';
      try { body = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
      body.split('\n').forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  return hits;
}

describe('every deployed Edge Function is auditable', () => {
  let deployed: string[] = [];
  before(() => {
    const out = execFileSync('npx', ['supabase', 'functions', 'list', '--project-ref', PROJECT_REF],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    deployed = (JSON.parse(out) as { functions: { slug: string }[] }).functions.map((f) => f.slug).sort();
  });

  test('the inventory is actually being read', () => {
    // "No orphans" means nothing if the list came back empty.
    assert.ok(deployed.length > 50,
      `only ${deployed.length} deployed functions were read — this check would pass vacuously`);
  });

  test('DEPLOYED → SOURCE EXISTS, for every function', () => {
    const local = new Set(localFunctions());
    const orphans = deployed
      .filter((s) => !local.has(s))
      .filter((s) => !DEPLOYED_WITHOUT_SOURCE_ALLOWED.includes(s));
    assert.deepEqual(orphans, [],
      `deployed in production with no source in git: ${orphans.join(', ')}. ` +
      `Recover it with \`supabase functions download <name> --project-ref ${PROJECT_REF}\`, ` +
      `audit it, then either commit the source or delete the deployment.`);
  });

  test('source-only functions are declared, not accidental', () => {
    // Reported rather than forbidden: this direction is legitimate. It fails
    // only so that an undeployed directory is a visible choice.
    const dep = new Set(deployed);
    const sourceOnly = localFunctions()
      .filter((d) => !dep.has(d))
      .filter((d) => !SOURCE_ONLY_ALLOWED.includes(d));
    assert.deepEqual(sourceOnly, [],
      `these have source but are not deployed: ${sourceOnly.join(', ')}. ` +
      `That may be perfectly fine — add them to SOURCE_ONLY_ALLOWED to record the decision.`);
  });

  test('the functions removed in Step 10D are still gone', () => {
    const back = DELETED_IN_10D.filter((f) => deployed.includes(f));
    assert.deepEqual(back, [],
      `these were deleted in Step 10D and have been redeployed: ${back.join(', ')}. ` +
      `They were superseded by the tier collapse (cb68afb); expire-requests was ` +
      `additionally reachable with only the public anon key.`);
  });
});

describe('nothing still points at the removed functions', () => {
  test('no code in either repository references them', () => {
    // Documentation may legitimately discuss them — SECURITY_AUDIT.md and
    // docs/tier-model.md both do, and that history is worth keeping. Only
    // committed code is checked.
    const hits = trackedMatches(
      new RegExp(`(${DELETED_IN_10D.join('|')})`),
      [REPO_ROOT, WEB_ROOT],
    );

    assert.deepEqual(hits, [],
      `code still references a deleted function:\n  ${hits.map((h) => h.slice(0, 150)).join('\n  ')}`);
  });

  test('no cron job, database function or trigger invokes them', () => {
    const pattern = DELETED_IN_10D.join('|');
    const rows = runSql(`
      select 'cron job' as kind, jobname as name from cron.job
       where command ~* '(${pattern})'
      union all
      select 'db function', n.nspname || '.' || p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosrc ~* '(${pattern})'
      union all
      select 'trigger', t.tgname
        from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where p.prosrc ~* '(${pattern})';`);
    assert.deepEqual(rows, [],
      `the database still references a deleted function: ` +
      rows.map((r) => `${r.kind} ${r.name}`).join(', '));
  });

  test('config.toml carries no entry for a deleted function', () => {
    const toml = readFileSync(join(REPO_ROOT, 'supabase', 'config.toml'), 'utf8');
    const stale = DELETED_IN_10D.filter((f) => toml.includes(`[functions.${f}]`));
    assert.deepEqual(stale, [],
      `config.toml still configures deleted function(s): ${stale.join(', ')}`);
  });
});
