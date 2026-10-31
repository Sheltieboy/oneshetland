#!/usr/bin/env node
// Replaces `npm test`, `npm run test:fixtures` and `npm run test:all` in this worktree. They ran suites that reach the PRODUCTION Supabase project
// (`supabase db query --linked`, service keys, the live site). Nothing here runs a test or opens a connection.
console.error(`
REFUSED: "${process.argv[2] ?? 'this script'}" is disabled in this checkout.

It used to run ~100 suites that query the production Supabase project. Use the local, fail-closed lanes instead:
  npm run test:isolated                       isolated Postgres only (ISOLATED_ONLY=<name> for one suite)
  supabase/tests/api/accept-env.sh start      local acceptance backend; then ACCEPT_RUN=1 node --test <one accept-*.node.test.ts>
The old file lists are kept as data in scripts/production-lanes.json. Running any of them against production needs written approval.
`);
process.exit(2);
