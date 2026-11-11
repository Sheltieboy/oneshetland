#!/usr/bin/env node
// run-with-guard.mjs: disable the approved webhook endpoints, run a command, ALWAYS restore afterwards (normal exit, failure, SIGINT, SIGTERM, SIGHUP, an uncaught error), verify.
//   node run-with-guard.mjs --allow ALLOW.txt --approved APPROVED.txt [--state STATE.json] [--allow-v2-unreadable] -- <command> [args...]
//   node run-with-guard.mjs restore-now --state STATE.json        manual recovery: re-enable exactly what the state file recorded and verify
// Exit: the command's own code; 4 (and a loud alert) when restoration cannot be verified (this overrides a command success); 2/3/5 as the guard.
// A SIGKILL or power loss cannot be trapped: run `restore-now` with the state file (its path is printed first, before anything is disabled).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'webhook-guard.mjs');
const STATE_DIR = process.env.GUARD_STATE_DIR ?? '/Users/darrenfullerton/Claude/safe-test/state';
const loud = (s) => process.stderr.write(`\n################ ${s} ################\n\n`);
const guard = (args) => spawnSync(process.execPath, [GUARD, ...args], { stdio: 'inherit' }).status ?? 1;

const argv = process.argv.slice(2);
if (argv[0] === 'restore-now') {
  const i = argv.indexOf('--state'); if (i < 0 || !argv[i + 1]) { console.error('usage: run-with-guard.mjs restore-now --state STATE.json'); process.exit(1); }
  process.exit(guard(['restore', '--state', argv[i + 1], ...(argv.includes('--allow-v2-unreadable') ? ['--allow-v2-unreadable'] : [])]));
}
const dash = argv.indexOf('--'); if (dash < 0 || dash === argv.length - 1) { console.error('usage: run-with-guard.mjs --allow F --approved F [--state F] -- command...'); process.exit(1); }
const opts = argv.slice(0, dash), cmd = argv.slice(dash + 1);
const get = (f) => { const i = opts.indexOf(f); return i >= 0 ? opts[i + 1] : undefined; };
const allow = get('--allow'), approved = get('--approved'); const v2 = opts.includes('--allow-v2-unreadable') ? ['--allow-v2-unreadable'] : [];
if (!allow || !approved) { console.error('--allow and --approved are required'); process.exit(1); }
const state = get('--state') ?? join(STATE_DIR, `guard-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
console.error('[run-with-guard] REMINDER: have you run `deno check` on editions-commerce-cron, editions-stripe-webhook and create-edition-checkout? (see README pre-check)');
console.error(`[run-with-guard] state file: ${state}\n[run-with-guard] manual recovery if this process is killed: node ${fileURLToPath(import.meta.url)} restore-now --state ${state}`);

let restored = false, child = null, signalled = null, cmdCode = 1, disableStarted = false;
const restore = () => {
  if (restored || !disableStarted) return 0; restored = true;
  const code = guard(['restore', '--state', state, ...v2]);
  if (code !== 0) loud(`RESTORATION NOT VERIFIED (exit ${code}). Stripe test-mode webhook endpoints may still be DISABLED or changed. Run: node ${fileURLToPath(import.meta.url)} restore-now --state ${state}`);
  return code;
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { signalled = sig; if (child && child.exitCode === null) child.kill(sig); else { const c = restore(); process.exit(c || 128); } });
process.on('uncaughtException', (e) => { console.error(e); const c = restore(); process.exit(c || 1); });
process.on('exit', () => { restore(); });   // last chance (synchronous work only)

disableStarted = true;   // set BEFORE the call: a crash mid-disable must still restore
const d = guard(['disable', '--allow', allow, '--approved', approved, '--state', state, ...v2]);
if (d !== 0) { loud(`disable failed (exit ${d}): the command will NOT run`); const r = restore(); process.exit(r || d); }
child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
child.on('error', (e) => { console.error(`[run-with-guard] cannot start the command: ${e.message}`); cmdCode = 127; });
child.on('exit', (code, sig) => {
  cmdCode = code ?? (sig ? 128 : 1);
  const r = restore();
  if (r !== 0) process.exit(4);
  process.exit(signalled ? 128 : cmdCode);
});
