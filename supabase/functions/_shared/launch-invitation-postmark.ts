/**
 * launch-invitation-postmark.ts — the one Postmark request the launch-outreach function makes.
 *
 * `fetch` is injected, so tests can prove the exact request without a network. The API key is used only as the
 * `X-Postmark-Server-Token` header: it is never put in a body, a log line, an error or a response.
 *
 * The MessageStream is whatever the message carries — the dedicated Launch Partner stream, set by the caller. There is deliberately no default here.
 *
 * It is a personal one-to-one note, not marketing: open tracking OFF, link tracking OFF (links are not rewritten),
 * no marketing footer, no unsubscribe machinery (the renderer's one quiet opt-out line asks for a plain reply), and provider metadata that never contains the link, token or recipient.
 */
import { ProviderRejected, ProviderUnknown, type MailMessage } from './launch-invitation-send.ts';

export const POSTMARK_URL = 'https://api.postmarkapp.com/email';
export const POSTMARK_TIMEOUT_MS = 20_000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function postmarkRequestBody(m: MailMessage): Record<string, unknown> {
  return {
    From: m.from, ReplyTo: m.replyTo, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html,
    MessageStream: m.messageStream, TrackOpens: false, TrackLinks: 'None', Metadata: m.metadata,
  };
}

export async function postmarkSend(fetchFn: FetchLike, apiKey: string, m: MailMessage, timeoutMs = POSTMARK_TIMEOUT_MS): Promise<{ id: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(POSTMARK_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': apiKey },
      body: JSON.stringify(postmarkRequestBody(m)),
      signal: ctl.signal,
    });
  } catch {
    // Timeout, dropped connection, DNS: the request may or may not have been processed.
    throw new ProviderUnknown('no answer from the mail provider');
  } finally {
    clearTimeout(timer);
  }
  let json: { MessageID?: string; ErrorCode?: number } = {};
  try { json = (await res.json()) as typeof json; } catch { /* unreadable body */ }
  if (res.ok && !json.ErrorCode && json.MessageID) return { id: json.MessageID };
  // A 4xx with a Postmark error code is an explicit refusal (bad address, inactive recipient, unverified sender…).
  if (res.status >= 400 && res.status < 500) throw new ProviderRejected(`mail provider refused the message (HTTP ${res.status})`, typeof json.ErrorCode === 'number' ? json.ErrorCode : undefined);
  // 5xx, or a 2xx we cannot read as an acceptance: unknown.
  throw new ProviderUnknown(`mail provider answer not conclusive (HTTP ${res.status})`);
}
