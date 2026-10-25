/**
 * scripts/test-safety/production.mjs — what "production" means to the test guard (Fetch v2, Step 13).
 *
 * Positive identification of the live OneShetland services, so the guard can refuse them by name rather than trusting a file called
 * .env.test. Every check here is pure (strings in, verdict out) and is unit-tested in supabase/tests/test-safety.node.test.ts.
 *
 * The production Supabase project is identified by its ref. Its API host is <ref>.supabase.co, its database host db.<ref>.supabase.co,
 * and its pooler login is postgres.<ref> on a pooler host shared with other Supabase customers. The tracked supabase/.temp/project-ref in
 * this repository links every fresh worktree to that project — which is how the Step 12 incident happened.
 */

/** The live project. ONESHETLAND_EXTRA_PRODUCTION_REFS adds refs (comma-separated) — used by the guard's own tests with a fake ref. */
export const PRODUCTION_REFS = ['nkrtmakxygkvxuxriiil', ...(process.env.ONESHETLAND_EXTRA_PRODUCTION_REFS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];

const HOSTED_SUPABASE = /(^|\.)supabase\.(co|com|in|net)$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/** Hosted services a test must never reach unless a lane explicitly allows it. */
export const LIVE_SERVICE_HOSTS = [
  { re: HOSTED_SUPABASE, name: 'Supabase (hosted)' },
  { re: /(^|\.)stripe\.(com|network)$/i, name: 'Stripe' },
  { re: /(^|\.)(exp\.host|expo\.dev|expo\.io)$/i, name: 'Expo (push / updates)' },
  { re: /(^|\.)(googleapis\.com|google\.com)$/i, name: 'Google APIs' },
  { re: /(^|\.)oneshetland\.com$/i, name: 'the live OneShetland website' },
  { re: /(^|\.)(apple\.com|push\.apple\.com|fcm\.googleapis\.com)$/i, name: 'push services' },
];

export function isLocalHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_HOSTS.has(h) || /^127\./.test(h) || h === '' || h.endsWith('.localhost');
}

/** Is this host one of production's own? (API, database, or the ref anywhere in the name.) */
export function isProductionHost(host) {
  const h = String(host ?? '').toLowerCase();
  return PRODUCTION_REFS.some((ref) => h === `${ref}.supabase.co` || h === `db.${ref}.supabase.co` || h.includes(ref));
}

/** Which live service a host belongs to, or null. */
export function liveService(host) {
  const h = String(host ?? '').toLowerCase();
  if (isProductionHost(h)) return 'the production Supabase project';
  return LIVE_SERVICE_HOSTS.find((s) => s.re.test(h))?.name ?? null;
}

/** Does this text (an env value, a DSN, a URL, a file) identify production? */
export function mentionsProduction(text) {
  const t = String(text ?? '');
  return PRODUCTION_REFS.some((ref) => t.includes(ref));
}

/** Live payment / push credentials, by their own published prefixes. */
export function liveCredential(text) {
  const t = String(text ?? '');
  if (/\b(sk|rk)_live_[A-Za-z0-9]{8,}/.test(t)) return 'a live Stripe secret key';
  if (/\bpk_live_[A-Za-z0-9]{8,}/.test(t)) return 'a live Stripe publishable key';
  if (/\bwhsec_[A-Za-z0-9]{16,}/.test(t)) return 'a Stripe webhook secret';
  return null;
}

/** Environment variables whose mere presence gives a test real power over a live service. */
export const LIVE_ENV_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET', 'EXPO_ACCESS_TOKEN', 'EXPO_TOKEN', 'GOOGLE_GEOCODING_API_KEY', 'GOOGLE_MAPS_SERVER_KEY', 'PGPASSWORD', 'DATABASE_URL'];

/**
 * What in an environment points at production or carries live power. Returns human reasons (empty = safe). Values are never echoed.
 * `SUPABASE_ACCESS_TOKEN=invalid-offline-run` is the lane's own placeholder and is allowed.
 */
export function productionFindings(env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (v == null || v === '') continue;
    if (k.startsWith('ONESHETLAND_') || k === 'NODE_OPTIONS') continue; // the guard's own settings
    if (mentionsProduction(v)) out.push(`${k} points at the production Supabase project`);
    const cred = liveCredential(v);
    if (cred) out.push(`${k} holds ${cred}`);
    if (LIVE_ENV_NAMES.includes(k) && !(k === 'SUPABASE_ACCESS_TOKEN' && v === 'invalid-offline-run')) out.push(`${k} is set (live credential)`);
  }
  return [...new Set(out)];
}

/** Supabase CLI subcommands that act on the LINKED (remote) project, or change it. */
const CLI_REMOTE = [/(^|\s)--linked(\s|=|$)/, /(^|\s)--db-url(\s|=|$)/, /(^|\s)--project-ref(\s|=|$)/, /\bdb\s+(push|pull|dump|remote|lint\s+--linked)\b/,
  /\b(link|unlink)\b/, /\bfunctions\s+(deploy|delete|download)\b/, /\bsecrets\b/, /\bmigration\s+(repair|fetch|squash)\b/, /\bprojects\b/, /\bbranches\b/,
  /\bstorage\s+(cp|rm|mv|ls)\b.*--linked/, /\bgen\s+types\b.*--(linked|project-id)/, /\binspect\b/, /\bsso\b/, /\borgs\b/];

/**
 * Would this child process reach or change a live service? `cmd` and `args` as given to child_process. Returns a reason or null.
 * Recognises the Supabase CLI (directly or via npx), psql/pg_dump to a non-local host, curl/wget to a live host, and EAS/Expo publishing.
 */
export function childProcessRisk(cmd, args = []) {
  const parts = [String(cmd ?? ''), ...args.map(String)];
  const line = parts.join(' ');
  const base = (p) => String(p).split('/').pop();
  // The programs actually being run: the command itself, what a package runner runs (npx supabase …), and the first word of a shell
  // script (sh -c "psql …"). Arguments are NOT programs — SQL or JSON that merely contains "http" or "curl" is not a request.
  const exe = [base(cmd)];
  if (['npx', 'pnpm', 'yarn', 'bunx', 'pnpx'].includes(exe[0])) exe.push(base(parts.find((p, i) => i > 0 && !p.startsWith('-')) ?? ''));
  if (['sh', 'bash', 'zsh', 'dash'].includes(exe[0])) { const i = parts.indexOf('-c'); if (i > 0 && parts[i + 1]) exe.push(...parts[i + 1].split(/[;&|]+/).map((c) => base(c.trim().split(/\s+/)[0] ?? ''))); }
  const runs = (names) => exe.some((e) => names.includes(e));
  if (runs(['supabase']) && CLI_REMOTE.some((re) => re.test(line))) return `the Supabase CLI against the linked/remote project (${line.slice(0, 80)}…)`;
  if (runs(['psql', 'pg_dump', 'pg_restore', 'pg_dumpall'])) {
    const target = parts.find((p) => /^postgres(ql)?:\/\//.test(p)) ?? '';
    const host = /(?:^|\s)-h\s+(\S+)/.exec(line)?.[1] ?? /host=([^\s&]+)/.exec(target)?.[1] ?? /@([A-Za-z0-9.-]+)/.exec(target)?.[1];
    if (mentionsProduction(target) || mentionsProduction(host ?? '') || (host && !host.startsWith('/') && !isLocalHost(host) && liveService(host))) return `a database client pointed at ${liveService(host ?? '') ?? 'production'}`;
  }
  if (runs(['curl', 'wget', 'http', 'https', 'httpie'])) {
    const host = /https?:\/\/([^/\s:'"]+)/.exec(line)?.[1];
    if (host && !isLocalHost(host)) return `an HTTP client to ${host}`;
  }
  if (runs(['eas']) && /\b(build|submit|update|channel|secret|env)\b/.test(line)) return 'EAS (build / submit / update)';
  if (runs(['expo']) && /\b(publish|upload)\b/.test(line)) return 'Expo publishing';
  return null;
}

const WRITE_SQL = /\b(insert\s+into|update\s+[\w."]+\s+set|delete\s+from|truncate|alter\s|drop\s|create\s|grant\s|revoke\s|comment\s+on|vacuum|reindex|cluster|copy\s|call\s|do\s+\$|lock\s+table|refresh\s+materialized|security\s+label|reset\s+session|set\s+(session\s+)?(characteristics|default_transaction_read_only|transaction_read_only|role)|begin\b|start\s+transaction|commit\b|rollback\b|savepoint|prepare\s+transaction|listen|notify|pg_terminate|pg_cancel|lo_)/i;
/** For the opt-in production read-only lane: SQL that is not a plain read is refused (and the session is forced read-only besides). */
export function sqlWriteReason(sql) {
  const m = WRITE_SQL.exec(String(sql ?? '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  return m ? `the statement contains "${m[0].trim()}"` : null;
}
