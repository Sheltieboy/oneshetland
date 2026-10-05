/**
 * launch-invitation-send.ts — the launch-partner invitation send, as a pure, testable core.
 *
 * Everything with a side effect is INJECTED (database calls, the Postmark call, the clock), so every path — including
 * every failure — is exercised in tests without a mailbox or a network. The Edge Function (send-launch-invitation)
 * only wires real implementations into this.
 *
 * ORDER OF EVENTS (the order is the safety):
 *   1. Check configuration (sender + reply address exist). No sender => stop, before anything is touched.
 *   2. Read the campaign and invitation FROM THE DATABASE. Nothing about the draft, recipient or invitation is trusted
 *      from the browser; the browser supplies only the campaign id, the private link's token, and what the administrator
 *      confirmed (recipient + subject), which must still match what is saved.
 *   3. Evaluate every gate. Any failure => stop, nothing reserved, nothing sent.
 *   4. RESERVE the send in the database (a claim). A second click, tab or retry finds the reservation and stops.
 *   5. Call the mail provider.
 *        accepted           => record "sent" in the database.
 *        definitely refused => release the reservation (nothing went out; a retry is safe).
 *        outcome unknown    => KEEP the reservation (it may have gone out; a blind retry could double-send) and say so.
 *   6. A send that succeeded but could not be recorded is reported as such and keeps its reservation — it never
 *      silently becomes "not sent" and is never recorded as "sent" when the provider refused.
 *
 * This is not a general email relay: it can send exactly one thing — the saved invitation for a campaign — to that
 * campaign's saved contact, with that campaign's own private link.
 */
import { checkEmail, renderInvitationEmail } from './launch-invitation-email.ts';

export type GateFailure =
  | 'not_confirmed' | 'already_sent' | 'not_ready' | 'contact_missing' | 'contact_invalid' | 'draft_incomplete'
  | 'invitation_invalid' | 'invitation_expired' | 'link_missing' | 'recipient_changed' | 'subject_changed';

export type FailureCode =
  | GateFailure | 'bad_request' | 'not_found' | 'not_configured' | 'send_in_progress' | 'provider_rejected' | 'outcome_unknown';

export interface CampaignFacts {
  id: string; slug: string; businessId: string; businessName: string; stage: string; sentAt: string | null;
  contactEmail: string | null; subject: string | null; opening: string | null; body: string | null;
  invitation: { status: string; expiresAt: string | null };
}

export interface MailMessage {
  from: string; replyTo: string; to: string; subject: string; text: string; html: string; metadata: Record<string, string>;
}

/** The provider refused this message outright (an HTTP error answer). Nothing was sent; retrying is safe. */
export class ProviderRejected extends Error {}
/** We cannot know whether the provider accepted it (timeout, dropped connection, 5xx). It may have gone out. */
export class ProviderUnknown extends Error {}

export interface SendDeps {
  getCampaign(id: string): Promise<CampaignFacts | null>;
  /** The business the token is valid for under this preview name, or null (invalid, revoked or expired). */
  resolveToken(slug: string, token: string): Promise<string | null>;
  claimSend(id: string): Promise<{ ok: true } | { ok: false; reason: 'already_sent' | 'not_ready' | 'send_in_progress' }>;
  releaseSend(id: string): Promise<void>;
  markSent(id: string, note: string): Promise<void>;
  /** Resolves with the provider's message id; throws ProviderRejected or ProviderUnknown. */
  send(message: MailMessage): Promise<{ id: string }>;
  now(): Date;
  origin: string;
  from: string | null;
  replyTo: string | null;
  log?(line: string): void;
}

export interface SendRequest {
  campaignId: unknown; token: unknown;
  confirmation: { confirm?: unknown; recipient?: unknown; subject?: unknown } | null | undefined;
}

export const MESSAGE: Record<FailureCode, string> = {
  not_confirmed: 'Confirm the send first.',
  already_sent: 'This invitation email has already been recorded as sent.',
  not_ready: 'Mark the campaign Ready to invite first.',
  contact_missing: "Add the contact's email address.",
  contact_invalid: "The contact's email address doesn't look right.",
  draft_incomplete: 'Finish and save the email draft first (subject, message, and your own personalised opening).',
  invitation_invalid: 'There is no valid invitation for this business.',
  invitation_expired: 'The invitation has expired. Generate a new one.',
  link_missing: 'The private link is only available right after you generate the invitation. Generate a new invitation to send it.',
  recipient_changed: 'The recipient changed since you confirmed. Review and confirm again.',
  subject_changed: 'The subject changed since you confirmed. Review and confirm again.',
  bad_request: 'That request was not understood.',
  not_found: 'That campaign was not found.',
  not_configured: "Sending from OneShetland isn't configured yet, so nothing was sent.",
  send_in_progress: 'A send for this campaign is already in progress or its outcome is unknown. Check the mail provider’s activity before trying again.',
  provider_rejected: 'The mail provider refused the message, so nothing was sent. You can try again.',
  outcome_unknown: 'The mail provider did not answer, so it is not known whether the email went out. It has NOT been recorded as sent and a resend is blocked for 30 minutes. Check the mail provider’s activity before trying again.',
};

export type SendResult =
  | { ok: true; messageId: string; recipient: string; recorded: boolean; expiresAt: string | null }
  | { ok: false; code: FailureCode; failures: FailureCode[]; message: string };

const fail = (code: FailureCode, failures: FailureCode[] = [code]): SendResult => ({ ok: false, code, failures, message: failures.map((f) => MESSAGE[f]).join(' ') });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{40,128}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Every gate that is not satisfied. Empty means the send may proceed to reservation. */
export function evaluateGates(c: CampaignFacts, tokenValid: boolean, conf: { confirm: boolean; recipient: string; subject: string } | null, now: Date): GateFailure[] {
  const f: GateFailure[] = [];
  if (!conf?.confirm) f.push('not_confirmed');
  if (c.sentAt) f.push('already_sent');
  if (c.stage !== 'ready_to_invite') f.push('not_ready');
  if (!c.contactEmail?.trim()) f.push('contact_missing'); else if (!EMAIL.test(c.contactEmail.trim())) f.push('contact_invalid');
  if (c.contactEmail?.trim() && !checkEmail({ subject: c.subject, body: c.body, opening: c.opening, contactEmail: c.contactEmail }).ok) f.push('draft_incomplete');
  const live = ['open', 'claim pending', 'claimed'].includes(c.invitation.status);
  const expired = !!c.invitation.expiresAt && new Date(c.invitation.expiresAt) <= now;
  if (!live || !tokenValid) f.push(expired ? 'invitation_expired' : 'invitation_invalid');
  else if (expired) f.push('invitation_expired');
  if (conf?.confirm) {
    if (c.contactEmail && conf.recipient.trim().toLowerCase() !== c.contactEmail.trim().toLowerCase()) f.push('recipient_changed');
    if (c.subject && conf.subject !== c.subject) f.push('subject_changed');
  }
  return f;
}

export async function launchInvitationSend(req: SendRequest, deps: SendDeps): Promise<SendResult> {
  // 0. shape of the request (never trust it)
  const conf = req.confirmation;
  if (typeof req.campaignId !== 'string' || !UUID.test(req.campaignId) || typeof req.token !== 'string' || !TOKEN.test(req.token)
    || !conf || typeof conf.recipient !== 'string' || typeof conf.subject !== 'string') return fail('bad_request');
  // 1. configuration, before anything is read or reserved
  if (!deps.from || !deps.replyTo) return fail('not_configured');
  // 2. facts from the database
  const c = await deps.getCampaign(req.campaignId);
  if (!c) return fail('not_found');
  const tokenBusiness = await deps.resolveToken(c.slug, req.token);
  const tokenValid = tokenBusiness === c.businessId;
  // 3. gates
  const gates = evaluateGates(c, tokenValid, { confirm: conf.confirm === true, recipient: conf.recipient, subject: conf.subject }, deps.now());
  if (gates.length) return fail(gates[0], gates);
  // 4. the message: rendered here from the SAVED draft, with this campaign's own private link
  const url = `${deps.origin.replace(/\/$/, '')}/launch/${c.slug}?invite=${req.token}`;
  const email = renderInvitationEmail({ subject: c.subject!, body: c.body!, opening: c.opening, businessName: c.businessName, invitationUrl: url });
  if (!email.hasInvitation) return fail('link_missing');
  // 5. reserve — the double-send guard
  const claim = await deps.claimSend(c.id);
  if (!claim.ok) return fail(claim.reason === 'send_in_progress' ? 'send_in_progress' : claim.reason === 'already_sent' ? 'already_sent' : 'not_ready');
  // 6. send
  let id: string;
  try {
    const res = await deps.send({
      from: deps.from, replyTo: deps.replyTo, to: c.contactEmail!.trim(), subject: email.subject, text: email.text, html: email.html,
      // Provider-side metadata: NEVER the link, the token or the recipient.
      metadata: { kind: 'launch_partner_invitation', campaign: c.slug },
    });
    id = res.id;
  } catch (e) {
    if (e instanceof ProviderRejected) {
      await deps.releaseSend(c.id).catch(() => { /* a stuck reservation expires on its own; never mask the real answer */ });
      deps.log?.(`launch invitation: provider rejected (campaign ${c.slug})`);
      return fail('provider_rejected');
    }
    // Anything else — including an unexpected exception — is treated as UNKNOWN: it may have been sent.
    deps.log?.(`launch invitation: outcome unknown (campaign ${c.slug})`);
    return fail('outcome_unknown');
  }
  // 7. record it. Two attempts; if both fail the email HAS gone — say so, keep the reservation.
  const note = `Emailed from Admin (provider message ${id})`;
  let recorded = false;
  for (let attempt = 0; attempt < 2 && !recorded; attempt++) {
    try { await deps.markSent(c.id, note); recorded = true; } catch { /* retried once */ }
  }
  if (!recorded) deps.log?.(`launch invitation: SENT but not recorded (campaign ${c.slug}, provider message ${id})`);
  return { ok: true, messageId: id, recipient: c.contactEmail!.trim(), recorded, expiresAt: c.invitation.expiresAt };
}

/** The bare address inside a "Name <address>" sender (or the address itself). */
export function addressOf(from: string | null | undefined): string | null {
  const m = from ? /<([^@\s>]+@[^@\s>]+)>/.exec(from) ?? /^([^@\s]+@[^@\s]+)$/.exec(from.trim()) : null;
  return m ? m[1] : null;
}

/** A sender is accepted only as "Name <address>" or a bare address. */
export function validSender(from: string | null | undefined): string | null {
  const f = from?.trim();
  return f && /<[^@\s>]+@[^@\s>]+>|^[^@\s]+@[^@\s]+$/.test(f) ? f : null;
}

/** Reply-To: LAUNCH_OUTREACH_REPLY_TO if set, otherwise the BARE address of the sender — never the display string. */
export function resolveReplyTo(from: string | null | undefined, override: string | null | undefined): string | null {
  return addressOf(override) ?? addressOf(validSender(from));
}
