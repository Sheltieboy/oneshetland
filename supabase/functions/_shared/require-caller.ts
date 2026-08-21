/**
 * require-caller.ts — who is actually asking.
 *
 * WHY THIS EXISTS
 *
 * Six notification fan-outs had no caller check at all. They ran with
 * verify_jwt=true, which looks like authentication and is not: the PUBLIC ANON
 * KEY is itself a valid JWT, and it ships in the website bundle. Verified
 * against production — sending only the anon key reached the handler and its
 * database lookups:
 *
 *   notify-event-update  →  404 "update not found"
 *   notify-engagement    →  404 "comment not found"
 *   notify-hub-content   →  400 "event and hub_id required"
 *
 * A 404 there means the request was accepted, the id was looked up, and only
 * the made-up id stopped it. A real event id would have emailed and pushed
 * every ticket holder of somebody else's event, from OneShetland, with no
 * account required.
 *
 * The gateway's verify_jwt is a shape check, not an authorisation check. This
 * is the authorisation check.
 *
 * Every caller of these functions is a signed-in person in the app or on the
 * website doing something they just did — there are no server-to-server
 * callers, which is what makes requiring a real user safe.
 */

export interface Caller {
  userId: string;
  isServiceRole: boolean;
}

/**
 * Resolves the caller to a real user, or returns the Response to send back.
 *
 * The anon key is rejected specifically: it carries `role: "anon"`, no `sub`,
 * and passes verify_jwt happily. A service-role token is accepted so a trusted
 * backend caller can still fan out if one is ever added.
 */
export async function requireCaller(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<{ caller: Caller } | { denied: Response }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const raw = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return { denied: json({ error: 'Unauthorised' }, 401) };

  // A trusted backend caller.
  if (serviceKey && raw === serviceKey) return { caller: { userId: '', isServiceRole: true } };
  try {
    const [, payload] = raw.split('.');
    if (payload) {
      const pad = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      const claims = JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/')));
      if (claims?.role === 'service_role') return { caller: { userId: '', isServiceRole: true } };
      // The anon key reaches here: role 'anon', no subject. Refused explicitly
      // rather than left to fail later, because "later" was never.
      if (!claims?.sub) return { denied: json({ error: 'Unauthorised' }, 401) };
    }
  } catch { /* fall through to the authoritative check below */ }

  // Authoritative: ask Supabase who this token belongs to. A forged or expired
  // token fails here even if its claims looked plausible above.
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const asCaller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${raw}` } },
  });
  const { data: { user } } = await asCaller.auth.getUser();
  if (!user) return { denied: json({ error: 'Unauthorised' }, 401) };

  return { caller: { userId: user.id, isServiceRole: false } };
}

/** The standard refusal, so every fan-out says the same uninformative thing. */
export function forbidden(corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: 'Not allowed' }), {
    status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
