/**
 * Canonical comparison of a migration's SQL with what production recorded in supabase_migrations.schema_migrations.statements:
 * comments, whitespace, semicolons and case are ignored, and a wrapping begin/commit is dropped. Two texts with the same normal form execute identically.
 * Used by scripts/snapshot-production-migrations.mjs (to record the hash) and supabase/tests/migration-immutability.node.test.ts (to verify it).
 */
import { createHash } from "node:crypto";

export function normalise(sql) {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").replace(/\s+/g, "").replace(/;/g, "").toLowerCase();
  s = s.replace(/^begin/, "").replace(/commit$/, "");
  return s;
}
export const hashOf = (sql) => createHash("sha256").update(normalise(sql)).digest("hex");
