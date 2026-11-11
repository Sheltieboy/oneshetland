// Mints a LOCAL-ONLY service_role JWT from the local stack's JWT secret (read from the environment, never printed except to the file named by --out, mode 0600).
import { createHmac } from 'node:crypto'; import { writeFileSync } from 'node:fs';
const secret = process.env.SUPABASE_JWT_SECRET; if (!secret) { console.error('SUPABASE_JWT_SECRET not set'); process.exit(1); }
const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b({ alg: 'HS256', typ: 'JWT' }), pay = b({ iss: 'local-editions', role: 'service_role', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 2 });
const jwt = `${head}.${pay}.${createHmac('sha256', secret).update(`${head}.${pay}`).digest('base64url')}`;
const i = process.argv.indexOf('--out'); if (i < 0) { console.error('--out FILE required'); process.exit(1); }
writeFileSync(process.argv[i + 1], jwt, { mode: 0o600 });
