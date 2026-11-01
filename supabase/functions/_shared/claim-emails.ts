/**
 * claim-emails.ts — the emails around a business claim, on the existing email infrastructure (email_templates -> sendEmail -> Postmark -> email_log).
 *
 *   emailClaimReceived   claimant: "we've got your claim"            + every admin: "new claim to review"
 *   emailClaimOutcome    claimant: approved / not approved
 *
 * WHO GETS WRITTEN TO. The claimant's ACCOUNT email (confirmed at sign-up), never the free-text contact email typed into the claim form: otherwise
 * the form could be used to send a message to any address. Admins are the accounts with role = 'admin'.
 *
 * NEVER BREAKS THE CLAIM. Every function returns a result and never throws: a failed email must not undo, or look like it undid, a saved claim or an
 * admin decision. Each is sent at most once per claim and template (checked in email_log), so a retried notification does not email twice.
 * No timescale is promised anywhere.
 */

type Svc = any;
export type SendFn = (svc: Svc, input: { templateKey: string; recipientEmail: string; recipientId?: string | null; variables?: Record<string, string>; metadata?: Record<string, unknown> }) => Promise<{ ok: boolean; skipped: boolean; error?: string }>;
export type Deps = { send?: SendFn; siteUrl?: string };

const SITE = 'https://oneshetland.com';
const trim = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function sender(deps: Deps): Promise<SendFn> {
  if (deps.send) return deps.send;
  return (await import('./send-email.ts')).sendEmail as SendFn;
}

async function accountEmail(svc: Svc, userId: string): Promise<string | null> {
  try { const { data } = await svc.auth.admin.getUserById(userId); return data?.user?.email ?? null; } catch { return null; }
}

async function alreadySent(svc: Svc, templateKey: string, recipientEmail: string, claimId: string): Promise<boolean> {
  try {
    const { data } = await svc.from('email_log').select('id').eq('template_key', templateKey).eq('recipient_email', recipientEmail).contains('metadata', { claim_id: claimId }).in('status', ['sent', 'skipped']).limit(1);
    return (data ?? []).length > 0;
  } catch { return false; }   // if we cannot tell, send: a repeat is better than silence
}

type ClaimRow = { id: string; user_id: string; business_id: string; contact_name: string | null; contact_email: string | null; role: string | null; evidence: string | null };

async function load(svc: Svc, claimId: string) {
  const { data: claim } = await svc.from('business_claims').select('id, user_id, business_id, contact_name, contact_email, role, evidence').eq('id', claimId).maybeSingle();
  if (!claim) return null;
  const c = claim as ClaimRow;
  const { data: biz } = await svc.from('local_businesses').select('name').eq('id', c.business_id).maybeSingle();
  const { data: prof } = await svc.from('profiles').select('full_name, display_name').eq('id', c.user_id).maybeSingle();
  const first = trim(c.contact_name || prof?.full_name || prof?.display_name || '', 60).split(' ')[0] || 'there';
  return { c, businessName: trim(biz?.name, 120) || 'your business', name: first };
}

async function sendOnce(svc: Svc, send: SendFn, templateKey: string, to: string, recipientId: string | null, variables: Record<string, string>, claimId: string) {
  if (await alreadySent(svc, templateKey, to, claimId)) return { sent: false, reason: 'already-sent' as const };
  try {
    const r = await send(svc, { templateKey, recipientEmail: to, recipientId, variables, metadata: { claim_id: claimId } });
    return { sent: r.ok && !r.skipped, reason: r.ok ? (r.skipped ? ('template-disabled' as const) : ('sent' as const)) : ('failed' as const), error: r.error };
  } catch (e) { return { sent: false, reason: 'failed' as const, error: e instanceof Error ? e.message : String(e) }; }
}

export async function emailClaimReceived(svc: Svc, claimId: string, deps: Deps = {}) {
  const out = { claimant: null as null | { sent: boolean; reason: string }, admins: 0, errors: [] as string[] };
  try {
    const send = await sender(deps); const site = deps.siteUrl ?? SITE;
    const loaded = await load(svc, claimId);
    if (!loaded) { out.errors.push('claim not found'); return out; }
    const { c, businessName, name } = loaded;

    const to = await accountEmail(svc, c.user_id);
    if (to) {
      out.claimant = await sendOnce(svc, send, 'business.claim_received', to, c.user_id, { name, business_name: businessName }, claimId);
      if (out.claimant.reason === 'failed') out.errors.push('claimant email failed');
    } else out.errors.push('claimant has no account email');

    const { data: admins } = await svc.from('profiles').select('id').eq('role', 'admin').limit(20);
    for (const a of (admins ?? []) as { id: string }[]) {
      const email = await accountEmail(svc, a.id);
      if (!email) continue;
      const r = await sendOnce(svc, send, 'admin.business_claim_received', email, a.id, {
        claimant_name: trim(c.contact_name, 80) || 'Someone', claimant_email: trim(c.contact_email, 120) || to || 'not given', business_name: businessName,
        role: trim(c.role, 80) || 'not given', evidence: trim(c.evidence, 300) || 'not given', review_url: `${site}/admin/claims`,
      }, claimId);
      if (r.sent) out.admins++; else if (r.reason === 'failed') out.errors.push('admin email failed');
    }
  } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); }
  return out;
}

export async function emailClaimOutcome(svc: Svc, claimId: string, outcome: 'approved' | 'rejected', deps: Deps = {}) {
  const out = { sent: false, reason: 'not-attempted', errors: [] as string[] };
  try {
    const send = await sender(deps); const site = deps.siteUrl ?? SITE;
    const loaded = await load(svc, claimId);
    if (!loaded) { out.errors.push('claim not found'); return out; }
    const { c, businessName, name } = loaded;
    const to = await accountEmail(svc, c.user_id);
    if (!to) { out.reason = 'no-email'; out.errors.push('claimant has no account email'); return out; }
    const approved = outcome === 'approved';
    const r = await sendOnce(svc, send, approved ? 'business.claim_approved' : 'business.claim_rejected', to, c.user_id,
      approved ? { name, business_name: businessName, manage_url: `${site}/business/${c.business_id}/manage` } : { name, business_name: businessName }, claimId);
    out.sent = r.sent; out.reason = r.reason; if (r.reason === 'failed') out.errors.push('outcome email failed');
  } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); }
  return out;
}
