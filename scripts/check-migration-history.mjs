#!/usr/bin/env node
/**
 * check-migration-history.mjs — READ-ONLY. Compares a directory of migration files with the migration history recorded in the linked production database.
 *   node scripts/check-migration-history.mjs [--dir <path-to-supabase/migrations>]
 * Runs ONE SELECT (supabase db query --linked). Exit 1 if it finds a problem that would make a deployment skip, reorder or mis-record a migration:
 *   COLLISION     a local file whose VERSION is already applied in production under a DIFFERENT NAME. `supabase db push` would treat it as applied and silently skip it.
 *   OUT-OF-ORDER  a local file that is NOT applied but is older than the newest applied version (it would be inserted behind production's history).
 * Also reports, for information, applied versions that have no local file (history that lives on another branch).
 * Run it before ANY deployment of a branch that carries migrations, and fix by renumbering the unapplied file (never by editing history).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const dirArg = process.argv.indexOf("--dir");
const dir = resolve(dirArg > -1 ? process.argv[dirArg + 1] : "supabase/migrations");
const out = execFileSync("supabase", ["db", "query", "--linked", "select version, name from supabase_migrations.schema_migrations order by version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const rows = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).rows;
const remote = new Map(rows.map((r) => [r.version, r.name]));
const newest = [...remote.keys()].sort().at(-1);
const local = readdirSync(dir).filter((f) => /^\d{12,14}_.+\.sql$/.test(f)).map((f) => { const m = /^(\d+)_(.+)\.sql$/.exec(f); return { file: f, version: m[1], name: m[2] }; });
const collisions = local.filter((l) => remote.has(l.version) && remote.get(l.version) !== l.name);
const outOfOrder = local.filter((l) => !remote.has(l.version) && l.version < newest);
const pending = local.filter((l) => !remote.has(l.version) && l.version >= newest);
const noFile = [...remote.keys()].filter((v) => !local.some((l) => l.version === v));
console.log(`Production: ${remote.size} applied, newest ${newest}. Directory: ${local.length} files. Pending (safe to apply, in order): ${pending.length}. Applied versions with no file here: ${noFile.length}.`);
for (const c of collisions) console.log(`COLLISION     ${c.file}  — version ${c.version} is applied in production as "${remote.get(c.version)}". Renumber this file above ${newest}.`);
for (const o of outOfOrder) console.log(`OUT-OF-ORDER  ${o.file}  — not applied, but older than the newest applied version ${newest}. Renumber it above ${newest}.`);
process.exit(collisions.length || outOfOrder.length ? 1 : 0);
