#!/usr/bin/env node
/**
 * editions-migration-reconcile.mjs — what would releasing this branch do to the production migration history, and what exact commands does it need?
 *
 * OFFLINE and read-only: it never connects to anything. It compares this branch's supabase/migrations with a list of the versions production has REGISTERED, which is
 * supplied as a file (the committed snapshot supabase/production/registered-migrations.json, or the output of `supabase migration list --linked` that Darren has approved
 * and saved). It prints what is only live, what is only on the branch (= what `db push` would apply), which release each pending migration belongs to, any ordering
 * hazard, and the exact commands to run, in order, each marked with whether it needs approval.
 *
 *   node scripts/editions-migration-reconcile.mjs                          uses the committed snapshot
 *   node scripts/editions-migration-reconcile.mjs --registered live.json   a saved JSON array, {versions:[..]} or `migration list` text/JSON
 *   node scripts/editions-migration-reconcile.mjs --migrations <dir>       a different migrations directory (rehearsals)
 *   node scripts/editions-migration-reconcile.mjs --json                   machine-readable
 *
 * Exit 0 = safe to proceed to the dry run. Exit 1 = a hazard needs a decision first. Exit 2 = could not read an input.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistered } from './check-migration-history.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Which release a migration belongs to, by its name. Everything unrecognised is "other" and is a hazard if pending. */
export const releaseOf = (file) => /_editions_/.test(file) ? 'editions' : /_my_saved\b/.test(file) ? 'my-saved' : /_admin_intelligence\b/.test(file) ? 'admin-intelligence' : /_home_announcements\b/.test(file) ? 'home-announcements' : 'other';

export const listMigrations = (dir) => readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort().map((f) => ({ version: f.slice(0, 14), file: f, release: releaseOf(f) }));

/**
 * @param local      [{version, file, release}]
 * @param registered string[] versions production has registered
 * @param hand       string[] versions applied by hand but not registered (normally empty)
 * @param opts       { only?: string }  the release being shipped; other pending releases are reported as "must be excluded or separately approved"
 */
export function plan(local, registered, hand = [], opts = {}) {
  const reg = new Set(registered), loc = new Map(local.map((m) => [m.version, m])), handSet = new Set(hand);
  const pending = local.filter((m) => !reg.has(m.version));
  const liveOnly = registered.filter((v) => !loc.has(v));
  const maxReg = registered.length ? [...registered].sort().pop() : '';
  const below = pending.filter((m) => m.version < maxReg);
  const handPending = pending.filter((m) => handSet.has(m.version));
  const byRelease = {};
  for (const m of pending) (byRelease[m.release] ??= []).push(m.version);
  const target = opts.only ?? null;
  const foreign = target ? pending.filter((m) => m.release !== target) : [];
  const hazards = [];
  if (liveOnly.length) hazards.push({ code: 'LIVE_ONLY', detail: `${liveOnly.length} version(s) are registered in production but have no file on this branch: ${liveOnly.join(', ')}. Restore the exact files from origin/main; do NOT repair them away.` });
  if (below.length) hazards.push({ code: 'OUT_OF_ORDER', detail: `${below.length} pending migration(s) sort BEFORE production's newest registered version (${maxReg}); db push would refuse them without --include-all: ${below.map((m) => m.version).join(', ')}.` });
  if (handPending.length) hazards.push({ code: 'HAND_APPLIED', detail: `${handPending.length} pending migration(s) are recorded as already applied by hand; registering them (not re-applying) is a separate approved step: ${handPending.map((m) => m.version).join(', ')}.` });
  if (pending.some((m) => m.release === 'other')) hazards.push({ code: 'UNKNOWN_RELEASE', detail: `pending migration(s) of an unknown release: ${pending.filter((m) => m.release === 'other').map((m) => m.file).join(', ')}` });
  if (foreign.length) hazards.push({ code: 'FOREIGN_RELEASES', detail: `this branch also carries ${foreign.length} pending migration(s) from other releases (${[...new Set(foreign.map((m) => m.release))].join(', ')}): a plain db push would apply them too. Ship from a release branch that contains only the ${target} migrations, or approve those releases explicitly.` });
  const commands = [];
  if (foreign.length && target) commands.push({ approval: 'none (local)', cmd: `git switch -c ${target}-release origin/main && git checkout editions-be -- ${pending.filter((m) => m.release === target).map((m) => `supabase/migrations/${m.file}`).join(' ')}`, why: `build a release branch with only the ${target} migrations on top of production's reconciled history` });
  commands.push({ approval: 'none (local)', cmd: 'node scripts/check-migration-history.mjs --registered <saved-list>', why: 'the existing guard: confirms only the intended versions differ' });
  commands.push({ approval: 'REQUIRED: read-only access to the live database', cmd: 'supabase migration list --linked > live-migration-list.txt', why: 'the ONE read the plan needs from production: which versions are registered today (read-only; carries no data)' });
  if (handPending.length) for (const m of handPending) commands.push({ approval: 'REQUIRED: changes production history', cmd: `supabase migration repair --status applied ${m.version} --linked`, why: 'register a migration that was applied by hand (do not re-run it)' });
  commands.push({ approval: 'REQUIRED: dry run reads the live history', cmd: 'supabase db push --linked --dry-run', why: 'prints exactly which migrations would be applied; it must list only the intended versions, in order' });
  for (const m of (target ? pending.filter((x) => x.release === target) : pending)) commands.push({ approval: 'REQUIRED: changes production', cmd: `# apply ${m.file} (via the approved db push, then run its post-check SQL)`, why: `post-check: supabase/production/post-checks/${m.file.replace(/^\d+_/, '').replace(/\.sql$/, '')}*.post-check.sql if present` });
  return { registered_count: registered.length, local_count: local.length, max_registered: maxReg, pending: pending.map((m) => ({ version: m.version, file: m.file, release: m.release })), pending_by_release: byRelease, live_only: liveOnly, out_of_order: below.map((m) => m.version), hazards, safe_to_dry_run: hazards.length === 0, commands };
}

function main(argv) {
  const a = argv.slice(2); const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  let registered, local, hand;
  try {
    registered = parseRegistered(readFileSync(opt('--registered') ?? join(ROOT, 'supabase/production/registered-migrations.json'), 'utf8'));
    local = listMigrations(opt('--migrations') ?? join(ROOT, 'supabase/migrations'));
    hand = JSON.parse(readFileSync(join(ROOT, 'supabase/production/hand-applied-migrations.json'), 'utf8')).migrations.map((m) => m.version);
  } catch (e) { console.error(`could not read an input: ${e.message}`); return 2; }
  const r = plan(local, registered, hand, { only: opt('--only') ?? 'editions' });
  if (a.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.hazards.length ? 1 : 0; }
  console.log(`Registered in production (per the supplied list): ${r.registered_count}, newest ${r.max_registered}`);
  console.log(`On this branch: ${r.local_count}. Pending (on the branch, not registered): ${r.pending.length}`);
  for (const [rel, vs] of Object.entries(r.pending_by_release)) console.log(`  ${rel}: ${vs.length}  (${vs[0]} … ${vs[vs.length - 1]})`);
  if (r.hazards.length) { console.log('\nHAZARDS (decide before any dry run):'); for (const h of r.hazards) console.log(`  [${h.code}] ${h.detail}`); }
  else console.log('\nNo hazards: ready for the approved dry run.');
  console.log('\nCommands, in order:'); r.commands.forEach((c, i) => console.log(`  ${i + 1}. ${c.cmd}\n       approval: ${c.approval}. ${c.why}`));
  return r.hazards.length ? 1 : 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv));
