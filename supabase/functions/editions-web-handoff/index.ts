import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireCaller } from '../_shared/require-caller.ts';
import { enforceRateLimit, GLOBAL_SUBJECT, userSubject } from '../_shared/rate-limit.ts';
import { accountDecision, ALLOWED_PATH, checkHash, CHECK_RE, CODE_RE, CODE_TTL_SECONDS, generateCheckNumber, generateCode, handoffUrl, parseMintBody, secretMatches, sha256Hex } from '../_shared/editions-web-handoff-core.ts';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-handoff-secret' };

/**
 * editions-web-handoff — the secure route from the native apps to the website's organiser management. NOT DEPLOYED; every switch defaults OFF.
 * Design and threat model: docs/editions/APP_HANDOFF_SECURITY.md (web repo). Actions:
 *
 *   mint     (the APP, signed in)       { action, organiser_id, destination, edition_id?, platform } -> { url, check_number, expires_in }
 *   peek     (the WEBSITE SERVER only)  { action, code, ip? }          -> { valid, user_id, email }     consumes nothing
 *   redeem   (the WEBSITE SERVER only)  { action, code, number, ip? }  -> { ok, token_hash, path, user_id } | { ok:false, reason?, left? }
 *   complete (the WEBSITE SERVER only)  { action, code, ok, reason? }  -> { ok }                        records the outcome AFTER the session exists
 *
 * peek, redeem and complete need the shared server secret HANDOFF_WEB_SECRET (compared by equal-length digests) and fail closed without it; calls without it are counted against a whole-endpoint
 * ceiling. The service-role key stays here. token_hash is returned only to that website server call, and only after every check has passed. The code and number are never logged.
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
      // An account the website would refuse anyway (banned, unconfirmed, deleted, MFA) gets no code and leaves no audit trail
      const me = await svc.auth.admin.getUserById(who.caller.userId);
      const factors = await svc.auth.admin.mfa.listFactors({ userId: who.caller.userId });
      if (factors.error || !accountDecision(me.data?.user as never, (factors.data?.factors ?? []) as never).ok) return refuse();
      const code = generateCode(), number = generateCheckNumber(), hash = await sha256Hex(code);
      const { error } = await svc.rpc('edition_handoff_mint', { p_user: who.caller.userId, p_org: m.organiser_id, p_destination: m.destination, p_edition: m.edition_id, p_platform: m.platform, p_code_hash: hash, p_check_hash: await checkHash(hash, number) });
      if (error) {
        // the reason (switch off, role, destination ...) is operator detail: logged by hint, never returned, never with the code
        const why = (error as { hint?: string }).hint ?? 'error', sqlState = (error as { code?: string }).code;
        console.warn('[editions-web-handoff] mint refused', why);
        return sqlState === '54000' ? json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' }) : refuse();
      }
      return json({ url: handoffUrl(Deno.env.get('SITE_ORIGIN'), code), check_number: number, expires_in: CODE_TTL_SECONDS });
    }

    // ── peek / redeem / complete: the website server only ───────────────────────────────────────────────────────────────────────────────────────
    if (action === 'peek' || action === 'redeem' || action === 'complete') {
      if (!(await secretMatches(Deno.env.get('HANDOFF_WEB_SECRET') ?? '', req.headers.get('x-handoff-secret') ?? ''))) {
        const brake = await enforceRateLimit('editions-web-handoff', GLOBAL_SUBJECT, ['editions_handoff_secret_fail'], corsHeaders);
        return 'denied' in brake ? brake.denied : refuse();                              // not configured, or not the website
      }
      const o = body as Record<string, unknown>;
      const code = typeof o.code === 'string' ? o.code : '';
      if (!CODE_RE.test(code)) return refuse();
      const hash = await sha256Hex(code);

      if (action === 'complete') {
        const ok = o.ok === true, reason = typeof o.reason === 'string' ? o.reason : 'failed';
        const { data } = await svc.rpc('edition_handoff_finish', { p_code_hash: hash, p_ok: ok, p_reason: reason });
        return json({ ok: data === true });
      }

      // Throttle by CODE always, and by client address only when the website passes a platform-verified one (never one shared "unknown" bucket).
      const ip = typeof o.ip === 'string' && o.ip.length > 0 && o.ip.length <= 64 && o.ip !== 'unknown' ? o.ip : null;
      const ipSubject = ip ? `ip:${(await sha256Hex(ip)).slice(0, 32)}` : null;
      const codeSubject = `code:${hash.slice(0, 32)}`;
      if (ipSubject) { const l = await enforceRateLimit('editions-web-handoff', ipSubject, [action === 'peek' ? 'editions_handoff_view_ip' : 'editions_handoff_redeem_ip'], corsHeaders); if ('denied' in l) return l.denied; }
      const perCode = await enforceRateLimit('editions-web-handoff', codeSubject, [action === 'peek' ? 'editions_handoff_view_code' : 'editions_handoff_redeem_code'], corsHeaders);
      if ('denied' in perCode) return perCode.denied;

      if (action === 'peek') {
        const { data: uid, error } = await svc.rpc('edition_handoff_peek', { p_code_hash: hash });
        if (error || !uid) return json({ valid: false });
        const { data } = await svc.auth.admin.getUserById(String(uid));
        if (!data?.user?.email) return json({ valid: false });
        return json({ valid: true, user_id: String(uid), email: data.user.email });   // the website shows this IN FULL so the person can see who they would be signed in as
      }

      // redeem: the database counts wrong numbers (three burn the code), consumes the code exactly once, and re-checks role, switches and organiser
      const number = typeof o.number === 'string' ? o.number : '';
      if (!CHECK_RE.test(number)) return json({ ok: false, reason: 'bad_number_format' });
      const { data: r, error } = await svc.rpc('edition_handoff_redeem', { p_code_hash: hash, p_check_hash: await checkHash(hash, number) });
      if (error) { console.error('[editions-web-handoff] redeem failed'); return json({ ok: false }); }
      if (r?.ok !== true) return json(r?.reason === 'bad_number' ? { ok: false, reason: 'bad_number', left: Number(r.left) || 0 } : { ok: false });
      if (typeof r.user_id !== 'string' || typeof r.path !== 'string' || !ALLOWED_PATH.test(r.path)) { await svc.rpc('edition_handoff_finish', { p_code_hash: hash, p_ok: false, p_reason: 'bad_destination' }); return json({ ok: false }); }
      const refused = async (reason: string) => {
        console.warn('[editions-web-handoff] account refused', reason);
        await svc.rpc('edition_handoff_finish', { p_code_hash: hash, p_ok: false, p_reason: reason });
        return json({ ok: false });
      };
      const { data: got } = await svc.auth.admin.getUserById(r.user_id);
      const factors = await svc.auth.admin.mfa.listFactors({ userId: r.user_id });
      if (factors.error) return refused('mfa_unknown');                                    // cannot prove there is no second factor: refuse
      const decision = accountDecision(got?.user as never, (factors.data?.factors ?? []) as never);
      if (!decision.ok) return refused(decision.reason);
      // LAST step, after every check: generateLink replaces any pending magic-link or OTP token for this user and its hash stays valid until the mailer expiry even if it is never
      // exchanged, so it is made only now and handed to nobody but this reply to the website server. Nothing is emailed.
      const link = await svc.auth.admin.generateLink({ type: 'magiclink', email: decision.email });
      const tokenHash = link.data?.properties?.hashed_token;
      if (link.error || !tokenHash) return refused('link_failed');
      return json({ ok: true, token_hash: tokenHash, path: r.path, user_id: r.user_id });
    }

    return json({ error: 'Bad request' }, 400);
  } catch (err) {
    console.error('[editions-web-handoff] unexpected failure');
    void err;
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
