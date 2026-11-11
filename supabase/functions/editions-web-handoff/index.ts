import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireCaller } from '../_shared/require-caller.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { accountDecision, ALLOWED_PATH, CODE_RE, CODE_TTL_SECONDS, generateCode, handoffUrl, maskEmail, parseMintBody, sha256Hex, timingSafeEqual } from '../_shared/editions-web-handoff-core.ts';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-handoff-secret' };

/**
 * editions-web-handoff — the secure route from the native apps to the website's organiser management. NOT DEPLOYED; every switch defaults OFF.
 * Design and threat model: docs/editions/APP_HANDOFF_SECURITY.md (web repo). Three actions:
 *
 *   mint    (the APP, signed in)       { action, organiser_id, destination, edition_id?, platform } -> { url, expires_in }
 *   peek    (the WEBSITE SERVER only)  { action, code, ip }  -> { valid, email_masked }     consumes nothing, for the confirmation page
 *   redeem  (the WEBSITE SERVER only)  { action, code, ip }  -> { ok, token_hash, path, user_id }    consumes the code exactly once
 *
 * peek and redeem need the shared server secret HANDOFF_WEB_SECRET (a browser or an app cannot call them) and fail closed without it. The service-role key stays here;
 * it is never given to the website. The code is never logged. Every refusal is one generic answer.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, ...extra, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const refuse = () => json({ error: 'Not available' }, 403);
  try {
    if (req.method !== 'POST') return json({ error: 'Not available' }, 405);
    const body = await req.json().catch(() => null);
    const action = body && typeof body === 'object' ? (body as Record<string, unknown>).action : null;
    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } });

    // ── mint ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    if (action === 'mint') {
      const who = await requireCaller(req, corsHeaders);
      if ('denied' in who) return who.denied;
      if (who.caller.isServiceRole || !who.caller.userId) return refuse();      // a real signed-in person only
      const limited = await enforceRateLimit('editions-web-handoff', userSubject(who.caller.userId), ['editions_handoff_mint', 'editions_handoff_mint_day'], corsHeaders);
      if ('denied' in limited) return limited.denied;
      const m = parseMintBody(body);
      if (!m) return json({ error: 'Bad request' }, 400);
      const code = generateCode();
      const { error } = await svc.rpc('edition_handoff_mint', { p_user: who.caller.userId, p_org: m.organiser_id, p_destination: m.destination, p_edition: m.edition_id, p_platform: m.platform, p_code_hash: await sha256Hex(code) });
      if (error) {
        // the reason (switch off, role, destination ...) is operator detail: logged by hint, never returned, never with the code
        const why = (error as { hint?: string }).hint ?? 'error', sqlState = (error as { code?: string }).code;
        console.warn('[editions-web-handoff] mint refused', why);
        return sqlState === '54000' ? json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' }) : refuse();
      }
      return json({ url: handoffUrl(Deno.env.get('SITE_ORIGIN'), code), expires_in: CODE_TTL_SECONDS });
    }

    // ── peek / redeem: the website server only ──────────────────────────────────────────────────────────────────────────────────────────────────
    if (action === 'peek' || action === 'redeem') {
      const secret = Deno.env.get('HANDOFF_WEB_SECRET') ?? '';
      const given = req.headers.get('x-handoff-secret') ?? '';
      if (secret.length < 32 || !timingSafeEqual(secret, given)) return refuse();       // not configured, or not the website
      const o = body as Record<string, unknown>;
      const code = typeof o.code === 'string' ? o.code : '';
      if (!CODE_RE.test(code)) return refuse();
      const hash = await sha256Hex(code);
      const ip = typeof o.ip === 'string' && o.ip.length > 0 && o.ip.length <= 64 ? o.ip : 'unknown';
      const ipSubject = `ip:${(await sha256Hex(ip)).slice(0, 32)}`;
      const limited = action === 'peek'
        ? await enforceRateLimit('editions-web-handoff', ipSubject, ['editions_handoff_view_ip'], corsHeaders)
        : await enforceRateLimit('editions-web-handoff', ipSubject, ['editions_handoff_redeem_ip'], corsHeaders);
      if ('denied' in limited) return limited.denied;
      if (action === 'redeem') {
        const perCode = await enforceRateLimit('editions-web-handoff', `code:${hash.slice(0, 32)}`, ['editions_handoff_redeem_code'], corsHeaders);
        if ('denied' in perCode) return perCode.denied;
      }

      if (action === 'peek') {
        const { data: uid, error } = await svc.rpc('edition_handoff_peek', { p_code_hash: hash });
        if (error || !uid) return json({ valid: false });
        const { data } = await svc.auth.admin.getUserById(String(uid));
        return json({ valid: true, email_masked: maskEmail(data?.user?.email) });
      }

      // redeem: the database consumes the code exactly once and re-checks the role, the switches and the organiser
      const { data: r, error } = await svc.rpc('edition_handoff_redeem', { p_code_hash: hash });
      if (error || !r || r.ok !== true || typeof r.user_id !== 'string' || typeof r.path !== 'string' || !ALLOWED_PATH.test(r.path)) {
        if (error) console.error('[editions-web-handoff] redeem failed');
        return json({ ok: false });
      }
      const { data: got } = await svc.auth.admin.getUserById(r.user_id);
      const factors = await svc.auth.admin.mfa.listFactors({ userId: r.user_id });
      if (factors.error) return json({ ok: false });                                   // cannot prove there is no second factor: refuse
      const decision = accountDecision(got?.user as never, (factors.data?.factors ?? []) as never);
      if (!decision.ok) { console.warn('[editions-web-handoff] account refused', decision.reason); return json({ ok: false }); }
      // A one-time token for the website SERVER to exchange with verifyOtp. Nothing is emailed; the token never leaves this call and the server-to-server reply.
      const link = await svc.auth.admin.generateLink({ type: 'magiclink', email: decision.email });
      const tokenHash = link.data?.properties?.hashed_token;
      if (link.error || !tokenHash) return json({ ok: false });
      return json({ ok: true, token_hash: tokenHash, path: r.path, user_id: r.user_id });
    }

    return json({ error: 'Bad request' }, 400);
  } catch (err) {
    console.error('[editions-web-handoff] unexpected failure');
    void err;
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
