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
  | 'do_not_contact' | 'not_confirmed' | 'already_sent' | 'not_ready' | 'contact_missing' | 'contact_invalid' | 'draft_incomplete'
  | 'invitation_invalid' | 'invitation_expired' | 'link_missing' | 'recipient_changed' | 'subject_changed';

export type FailureCode =
  | GateFailure | 'bad_request' | 'not_found' | 'not_configured' | 'stream_not_configured' | 'stream_missing' | 'stream_type_unsupported'
  | 'send_in_progress' | 'provider_rejected' | 'recipient_inactive' | 'outcome_unknown';

export interface CampaignFacts {
  id: string; slug: string; businessId: string; businessName: string; stage: string; sentAt: string | null;
  contactEmail: string | null; subject: string | null; opening: string | null; body: string | null;
  invitation: { status: string; expiresAt: string | null };
  /** Launch Partner outreach to this business (or this contact address) has been stopped. Read from the database with everything else. */
  outreachStopped?: boolean;
}

export interface MailMessage {
  from: string; replyTo: string; to: string; subject: string; text: string; html: string; metadata: Record<string, string>;
  /** The dedicated Launch Partner message stream. Always explicit — there is NO default, so a launch email can never fall back to the transactional stream. */
  messageStream: string;
}

/**
 * The streams Postmark creates for every server. Launch Partner outreach must NEVER be sent through any of them: 'outbound' carries the
 * transactional mail (password resets, tickets, receipts) and 'broadcast'/'broadcasts' carry newsletters. It needs a stream of its own, so its
 * bounces, complaints and suppressions are kept apart.
 */
export const SHARED_STREAMS = ['outbound', 'broadcast', 'broadcasts', 'inbound'] as const;

/**
 * The configured dedicated stream (LAUNCH_OUTREACH_MESSAGE_STREAM), or null when it is missing, malformed or one of the shared streams above.
 * null means "do not send": a missing or wrong setting fails CLOSED, it never degrades to the transactional stream.
 */
export function validMessageStream(v: string | null | undefined): string | null {
  const s = v?.trim();
  if (!s || !/^[a-z0-9][a-z0-9-]{2,49}$/.test(s)) return null;
  return (SHARED_STREAMS as readonly string[]).includes(s) ? null : s;
}

/** The provider refused this message outright (an HTTP error answer). Nothing was sent; retrying is safe. */
export class ProviderRejected extends Error {
  /** The provider's own error code when it gave one (406 = the address is inactive: a previous bounce or spam complaint). */
  errorCode?: number;
  constructor(message: string, errorCode?: number) { super(message); this.errorCode = errorCode; }
}
/** We cannot know whether the provider accepted it (timeout, dropped connection, 5xx). It may have gone out. */
export class ProviderUnknown extends Error {}

export interface SendDeps {
  getCampaign(id: string): Promise<CampaignFacts | null>;
  /** The business the token is valid for under this preview name, or null (invalid, revoked or expired). */
  resolveToken(slug: string, token: string): Promise<string | null>;
  claimSend(id: string): Promise<{ ok: true } | { ok: false; reason: 'already_sent' | 'not_ready' | 'send_in_progress' | 'do_not_contact' }>;
  releaseSend(id: string): Promise<void>;
  markSent(id: string, note: string): Promise<void>;
  /** Resolves with the provider's message id; throws ProviderRejected or ProviderUnknown. */
  send(message: MailMessage): Promise<{ id: string }>;
  now(): Date;
  origin: string;
  from: string | null;
  replyTo: string | null;
  /** The dedicated Launch Partner stream, already validated (validMessageStream). null = not configured = nothing is sent. */
  messageStream: string | null;
  log?(line: string): void;
}

export interface SendRequest {
  campaignId: unknown; token: unknown;
  confirmation: { confirm?: unknown; recipient?: unknown; subject?: unknown } | null | undefined;
}

export const MESSAGE: Record<FailureCode, string> = {
  do_not_contact: 'Launch Partner outreach to this business has been stopped (do not contact), so nothing was sent.',
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
  stream_not_configured: "Launch Partner sending has no dedicated mail stream set up (LAUNCH_OUTREACH_MESSAGE_STREAM is missing or not allowed), so nothing was sent. It will not fall back to the everyday email stream.",
  send_in_progress: 'A send for this campaign is already in progress or its outcome is unknown. Check the mail provider’s activity before trying again.',
  provider_rejected: 'The mail provider refused the message, so nothing was sent. You can try again.',
  stream_missing: "Postmark says the Launch Partner mail stream does not exist on this server (or has been archived), so nothing was sent. Create it in Postmark, make sure it matches LAUNCH_OUTREACH_MESSAGE_STREAM, then try again.",
  stream_type_unsupported: "Postmark won't send through the Launch Partner mail stream as it is set up (wrong stream type), so nothing was sent. Check the stream in Postmark.",
  recipient_inactive: 'The mail provider has marked this address as inactive (a previous bounce or spam complaint), so nothing was sent. Check the address — or, if they asked not to be emailed, record do not contact.',
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
  if (c.outreachStopped) f.push('do_not_contact');                       // first: nothing below can make a stopped business sendable
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
  // …and the DEDICATED stream. Without it nothing is read, reserved or sent — never a silent fallback to the transactional stream.
  const stream = validMessageStream(deps.messageStream);
  if (!stream) return fail('stream_not_configured');
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
  const email = renderInvitationEmail({ subject: c.subject!, body: c.body!, opening: c.opening, businessName: c.businessName, invitationUrl: url, invitationExpiresAt: c.invitation.expiresAt });
  if (!email.hasInvitation) return fail('link_missing');
  // 5. reserve — the double-send guard
  const claim = await deps.claimSend(c.id);
  // The database re-checks do-not-contact under the campaign lock: a page, a tab or a read that was stale cannot get past it.
  if (!claim.ok) return fail(claim.reason === 'do_not_contact' ? 'do_not_contact' : claim.reason === 'send_in_progress' ? 'send_in_progress' : claim.reason === 'already_sent' ? 'already_sent' : 'not_ready');
  // 6. send
  let id: string;
  try {
    const res = await deps.send({
      from: deps.from, replyTo: deps.replyTo, to: c.contactEmail!.trim(), subject: email.subject, text: email.text, html: email.html,
      // Provider-side metadata: NEVER the link, the token or the recipient.
      metadata: { kind: 'launch_partner_invitation', campaign: c.slug },
      messageStream: stream,
    });
    id = res.id;
  } catch (e) {
    if (e instanceof ProviderRejected) {
      await deps.releaseSend(c.id).catch(() => { /* a stuck reservation expires on its own; never mask the real answer */ });
      deps.log?.(`launch invitation: provider rejected (campaign ${c.slug})`);
      // Postmark's own codes: 406 inactive recipient · 1235 the stream does not exist on this server · 1236 sending not supported for this stream type.
      return fail(e.errorCode === 406 ? 'recipient_inactive' : e.errorCode === 1235 ? 'stream_missing' : e.errorCode === 1236 ? 'stream_type_unsupported' : 'provider_rejected');
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
