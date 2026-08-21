import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * validate-event-ticket
 *
 * The door. Takes a scanned QR or a hand-typed backup code and either admits the
 * attendee or says precisely why not.
 *
 * WHO THE SCANNER IS
 * The scanner's identity is taken from the JWT on the request and nowhere else.
 * The body is read for exactly three fields — event_id, raw_token, backup_code —
 * so there is no scanner_id for a client to supply, and supplying one has no
 * effect. Whatever ends up in the audit trail came from a verified session.
 *
 * WHO IS ALLOWED TO SCAN
 * can_scan_event() in the database is the single source of truth, called here
 * with the verified user id. This function used to carry its own copy of the
 * rule, which had drifted: it recognised profiles.role='admin' but not
 * is_platform_owner. One rule, one place.
 *
 * WHAT THIS FUNCTION DOES NOT DO
 * It does not decide whether a ticket may be spent. The single-use invariant
 * lives in redeem_ticket_atomic's conditional UPDATE, inside PostgreSQL, where
 * two simultaneous scans contend for the same row lock and exactly one wins.
 * Nothing in TypeScript can make a ticket redeemable twice, because nothing in
 * TypeScript is consulted.
 *
 * Body: { event_id: string, raw_token?: string, backup_code?: string }
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/**
 * Which of the two credentials is this?
 *
 * A raw token is 64 hex characters (32 random bytes) and only ever lives on the
 * buyer's phone. A web ticket cannot show one, so its QR encodes the backup code
 * instead — meaning a scanned QR string is sometimes a code, not a token.
 *
 * The two shapes cannot be confused: a backup code is at most nine characters
 * from an alphabet with no lowercase and no hex-only ambiguity. Deciding here,
 * rather than trying the token path and falling back on failure, matters — a
 * fallback would log a not_found for every successful web-ticket scan, and
 * those are exactly the rows the backup-code rate limiter counts. A busy
 * entrance would have throttled itself.
 *
 * The length test is deliberately generous. Codes issued before the generator
 * was fixed can be eight characters instead of nine, and they must still scan.
 */
function looksLikeBackupCode(scanned: string): boolean {
  const bare = scanned.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return bare.length > 0 && bare.length <= 12;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    // Identify the human on the handset from their session, not from the body.
    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorised' }, 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { event_id, raw_token, backup_code } = await req.json();
    if (!event_id || (!raw_token && !backup_code)) {
      return json({ error: 'event_id and (raw_token or backup_code) required' }, 400);
    }

    // Checked here so an unauthorised scanner gets a clean 403 rather than a
    // 200 carrying a refusal. The database re-checks this on every path — this
    // is the polite layer, not the enforcing one.
    const { data: allowed, error: authErr } = await supabase.rpc('can_scan_event', {
      p_event_id: event_id,
      p_user_id:  user.id,
    });
    if (authErr) throw new Error(authErr.message);
    if (!allowed) {
      return json({ error: 'You are not authorised to scan tickets for this event' }, 403);
    }

    // Route by credential shape, then hand the whole decision to the database.
    const scanned  = raw_token ?? backup_code;
    const asBackup = !raw_token || looksLikeBackupCode(String(raw_token));

    const { data, error } = asBackup
      ? await supabase.rpc('validate_backup_code', {
          p_backup_code: String(scanned).toUpperCase().replace(/[^A-Z0-9]/g, ''),
          p_event_id:    event_id,
          p_scanner_id:  user.id,
        })
      : await supabase.rpc('validate_and_checkin_ticket', {
          p_raw_token:  String(scanned),
          p_event_id:   event_id,
          p_scanner_id: user.id,
        });
    if (error) throw new Error(error.message);

    const result = data as Record<string, unknown> | null;

    // The database authorises independently, so it can refuse even when the
    // check above passed — a hub role revoked mid-shift, say. Honour its answer.
    if (result?.result === 'not_authorised') {
      return json({ error: 'You are not authorised to scan tickets for this event' }, 403);
    }
    // Both clients pull `error` out of a non-2xx body to show the operator what
    // happened; without it they fall back to a generic failure message, which is
    // useless on a door. Carry the real reason.
    if (result?.result === 'rate_limited') {
      return json({ ...result, error: result.message ?? 'Too many unrecognised codes — wait a few minutes.' }, 429);
    }

    if (result?.ticket_type_id) {
      const { data: tt } = await supabase
        .from('event_ticket_types')
        .select('name')
        .eq('id', result.ticket_type_id as string)
        .single();
      if (tt) result.ticket_type_name = tt.name;
    }

    return json(result);

  } catch (err) {
    console.error('[validate-event-ticket]', err);
    return json({ error: safeError('validate-event-ticket', err) }, 500);
  }
});
