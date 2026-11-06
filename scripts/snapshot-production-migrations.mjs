#!/usr/bin/env node
/**
 * snapshot-production-migrations.mjs — READ-ONLY. Refreshes supabase/production/registered-migrations.json from the linked production database:
 * every registered version, its NAME, and the hash of the normal form of the statements production RECORDED for it (see scripts/lib/migration-normalise.mjs).
 * That hash is what makes "applied migrations are immutable" testable offline (supabase/tests/migration-immutability.node.test.ts).
 *   node scripts/snapshot-production-migrations.mjs            writes the file
 *   node scripts/snapshot-production-migrations.mjs --check    exits 1 if the file differs from production (writes nothing)
 * Runs two SELECTs through `supabase db query --linked`. Run it in the SAME sitting as any `supabase migration repair` / hand-applied migration.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { normalise } from "./lib/migration-normalise.mjs";

const FILE = "supabase/production/registered-migrations.json";
const q = (sql) => { const out = execFileSync("supabase", ["db", "query", "--linked", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).rows; };
const idx = q("select version, name from supabase_migrations.schema_migrations order by version");
const st = new Map(q("select version, to_jsonb(statements) s from supabase_migrations.schema_migrations where statements is not null").map((r) => [r.version, Array.isArray(r.s) ? r.s : JSON.parse(r.s)]));
const prev = JSON.parse(readFileSync(FILE, "utf8"));
const next = {
  captured_on: new Date().toISOString().slice(0, 10), project_ref: prev.project_ref, how: "read-only: select version, name, statements from supabase_migrations.schema_migrations",
  note: prev.note, versions: idx.map((r) => r.version),
  names: Object.fromEntries(idx.map((r) => [r.version, r.name])),
  content_sha256: Object.fromEntries(idx.filter((r) => st.has(r.version)).map((r) => [r.version, createHash("sha256").update(normalise(st.get(r.version).join("\n"))).digest("hex")])),
};
const same = JSON.stringify({ v: prev.versions, n: prev.names, h: prev.content_sha256 }) === JSON.stringify({ v: next.versions, n: next.names, h: next.content_sha256 });
if (process.argv.includes("--check")) { console.log(same ? "snapshot matches production" : "SNAPSHOT DIFFERS from production"); process.exit(same ? 0 : 1); }
writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n");
console.log(`wrote ${FILE}: ${next.versions.length} versions, ${Object.keys(next.content_sha256).length} content hashes`);
