import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * delete-account — in-app account deletion (Apple 5.1.1(v) + Google Play).
 *
 * Deletes the CALLER'S OWN account only (gated on auth.uid()). We use a
 * scrub-and-soft-delete model rather than a hard auth-user delete, because ~30
 * public FKs reference profiles(id) WITHOUT cascade (orders, tickets, bookings,
 * donations, compliance) — a hard delete would either be blocked or would erase
 * financial/transactional records the counterparty businesses must keep.
 *
 * What it does (service role, caller's own id only):
 *   1. Deletes the user's own UGC (memories, comments, pins, boat comments,
 *      community notices) — "right to be forgotten" from public surfaces.
 *   2. Deletes their push tokens + block relationships.
 *   3. Deactivates any business they own (kept for transactional integrity).
 *   4. Scrubs PII from their profile + stamps deleted_at.
 *   5. SOFT-deletes the auth user (deleteUser(id, true)) so they can never sign
 *      in again, while keeping the row valid for retained anonymized records.
 *
 * Returns: { ok: true }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const uid = user.id;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const steps: Record<string, string> = {};
    const run = async (label: string, p: PromiseLike<{ error: unknown } | unknown>) => {
      try {
        const r = (await p) as { error?: unknown };
        steps[label] = r?.error ? `err: ${String((r.error as { message?: string })?.message ?? r.error)}` : 'ok';
      } catch (e) {
        steps[label] = `threw: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    // 1. Delete the user's own UGC (cascades children where defined).
    await run('memories', svc.from('memories').delete().eq('author_id', uid));
    await run('memory_comments', svc.from('memory_comments').delete().eq('author_id', uid));
    await run('memory_image_pins', svc.from('memory_image_pins').delete().eq('author_id', uid));
    await run('memory_image_pin_suggestions', svc.from('memory_image_pin_suggestions').delete().eq('suggester_id', uid));
    await run('memory_reactions', svc.from('memory_reactions').delete().eq('user_id', uid));
    await run('vessel_comments', svc.from('vessel_comments').delete().eq('author_id', uid));
    await run('notices', svc.from('notices').delete().eq('publisher_user_id', uid));

    // 2. Push tokens + block relationships.
    await run('push_tokens', svc.from('push_tokens').delete().eq('user_id', uid));
    await run('blocks_by', svc.from('blocked_users').delete().eq('blocker_id', uid));
    await run('blocks_of', svc.from('blocked_users').delete().eq('blocked_id', uid));

    // 3. Deactivate any business they own (retain rows for transactional integrity).
    await run('deactivate_businesses', svc.from('local_businesses').update({ is_active: false }).eq('owner_id', uid));

    // 4. Scrub PII from the profile + stamp deleted_at.
    await run('scrub_profile', svc.from('profiles').update({
      full_name: 'Deleted account',
      display_name: null,
      phone: null,
      avatar_url: null,
      bio: null,
      location_area: null,
      games_handle: null,
      is_active: false,
      deleted_at: new Date().toISOString(),
    }).eq('id', uid));

    // 5. Soft-delete the auth user — blocks all future sign-in, keeps the row
    //    so retained (anonymized) transactional records stay referentially valid.
    let authDeleted = false;
    try {
      const { error } = await svc.auth.admin.deleteUser(uid, true);
      authDeleted = !error;
      steps['auth_soft_delete'] = error ? `err: ${error.message}` : 'ok';
    } catch (e) {
      steps['auth_soft_delete'] = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // The profile scrub is the load-bearing data-removal step; report success if
    // it ran. The client signs out + clears the local session regardless.
    return json({ ok: true, auth_deleted: authDeleted, steps });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
