/**
 * production-lane-guard.ts — imported FIRST by every test that can reach a hosted Supabase project, a production API, a service-role key or the live site
 * (`supabase db query --linked`, `--project-ref`, service_key.txt, .env keys, fetches of oneshetland.com). Importing it throws, so the file fails before any of
 * its own code (or any query) runs, unless a person has deliberately set the approval variable below for that one command.
 *
 * Incident 31 Oct 2026: a bare `node --test` discovered these files and ran production-linked queries for ~33 minutes. This closes that route at the file level;
 * the checkout is also unlinked, `npm test` / `test:fixtures` / `test:all` refuse, and the isolated lane refuses an empty selection.
 */
const VAR = 'OS_ALLOW_PRODUCTION_PROBES';
const PHRASE = 'I-HAVE-WRITTEN-APPROVAL-TO-TOUCH-PRODUCTION';
if (process.env[VAR] !== PHRASE) {
  throw new Error(
    `REFUSED: this test can contact production. It never runs from a bare "node --test", "npm test" or a directory glob. ` +
    `Use the local lanes (npm run test:isolated, the accept-* suites). Production probes need written approval and ${VAR}=<the approval phrase> on that single command.`,
  );
}
export {};
