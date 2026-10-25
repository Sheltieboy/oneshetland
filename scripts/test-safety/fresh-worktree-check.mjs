#!/usr/bin/env node
/**
 * scripts/test-safety/fresh-worktree-check.mjs — the mandatory fresh-worktree safety check (Fetch v2, Step 13).
 *
 * Creates a brand-new git worktree of a commit (default HEAD) beside this checkout — tracked production link and all, no .env — and runs
 * `npm test` there with YOUR shell environment plus a planted production URL and a live-looking Stripe key, exactly the situation that
 * caused the Step 12 incident. It passes only if the lane ran with nothing blocked (nothing tried to leave the machine) and no new failures,
 * and if a bare guarded process given that same environment refuses to start. The worktree is removed afterwards.
 *
 * Usage: node scripts/test-safety/fresh-worktree-check.mjs [<commit>]
 * node_modules is linked from this checkout (a fresh worktree after `npm ci` has the same packages); nothing else is copied.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ref = process.argv[2] ?? 'HEAD';
const target = join(dirname(ROOT), `zz-fresh-worktree-check-${process.pid}`);
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
const planted = { EXPO_PUBLIC_SUPABASE_URL: 'https://nkrtmakxygkvxuxriiil.supabase.co', STRIPE_SECRET_KEY: 'sk_live_freshworktreecheck0000' };
let ok = false;
try {
  const add = git('worktree', 'add', '--detach', target, ref);
  if (add.status !== 0) throw new Error(add.stderr);
  console.log(`[fresh-worktree] ${basename(target)} at ${git('rev-parse', '--short', ref).stdout.trim()} — tracked project link present: ${existsSync(join(target, 'supabase/.temp/project-ref'))}; .env present: ${existsSync(join(target, '.env'))}`);
  symlinkSync(join(ROOT, 'node_modules'), join(target, 'node_modules'));

  // 1. A bare guarded process with a production environment must refuse to start.
  const bare = spawnSync(process.execPath, ['-e', 'console.log("RAN")'], { cwd: target, encoding: 'utf8',
    env: { ...process.env, ...planted, NODE_OPTIONS: `--import=${join(target, 'scripts/test-safety/guard.mjs')}` } });
  const bareOk = bare.status === 78 && !bare.stdout.includes('RAN');
  console.log(`[fresh-worktree] guarded process with a production URL and a live key: ${bareOk ? 'refused to start (exit 78)' : `DID NOT REFUSE (exit ${bare.status})`}`);

  // 2. npm test from the fresh worktree, with the developer's shell plus the planted values.
  const run = spawnSync('npm', ['test'], { cwd: target, encoding: 'utf8', env: { ...process.env, ...planted } });
  const out = run.stdout + run.stderr;
  const blocked = /External access attempts blocked by the guard: (\d+)/.exec(out)?.[1];
  const fresh = /NEW failures \(not in the .* baseline\): (\d+)/.exec(out)?.[1];
  const totals = /Safe offline tests: .*/.exec(out)?.[0];
  console.log(`[fresh-worktree] npm test: ${totals ?? '(no summary)'}`);
  console.log(`[fresh-worktree] external access attempts blocked: ${blocked}; new failures: ${fresh}; exit ${run.status}`);
  ok = bareOk && blocked === '0' && fresh === '0' && run.status === 0;
} catch (e) {
  console.error(`[fresh-worktree] could not run: ${e.message}`);
} finally {
  try { rmSync(join(target, 'node_modules'), { force: true }); } catch { /* ignore */ }
  git('worktree', 'remove', '--force', target);
  console.log(`[fresh-worktree] worktree removed: ${!existsSync(target)}`);
}
console.log(ok ? '[fresh-worktree] PASS — a fresh worktree cannot reach production through npm test' : '[fresh-worktree] FAIL');
process.exit(ok ? 0 : 1);
