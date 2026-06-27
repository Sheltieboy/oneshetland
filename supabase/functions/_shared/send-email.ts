/**
 * send-email.ts — shared Postmark email helper
 *
 * Usage:
 *   import { sendEmail } from '../_shared/send-email.ts';
 *
 *   await sendEmail(supabase, {
 *     templateKey: 'fetch.delivered',
 *     recipientId:    user.id,      // optional — used for log + preference checks
 *     recipientEmail: user.email,
 *     variables: {
 *       name:        'Darren',
 *       destination: 'Lerwick',
 *     },
 *   });
 *
 * The function:
 *   1. Loads the template from email_templates (checks enabled flag)
 *   2. Loads global settings (from name, footer)
 *   3. Interpolates {{variables}} in subject + body
 *   4. Appends the standard HTML footer
 *   5. Sends via Postmark API
 *   6. Writes to email_log
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface SendEmailInput {
  templateKey:    string;
  recipientEmail: string;
  recipientId?:   string | null;
  variables?:     Record<string, string>;
  metadata?:      Record<string, unknown>;
}

export interface SendEmailResult {
  ok:      boolean;
  skipped: boolean;   // true if template is disabled
  error?:  string;
  postmark_id?: string;
}

export async function sendEmail(
  supabase: SupabaseClient,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const { templateKey, recipientEmail, recipientId, variables = {}, metadata = {} } = input;

  // ── 1. Load template ──────────────────────────────────────────────────────
  const { data: tmpl, error: tmplErr } = await supabase
    .from('email_templates')
    .select('*')
    .eq('key', templateKey)
    .single();

  if (tmplErr || !tmpl) {
    console.warn(`[send-email] Template not found: ${templateKey}`);
    await logEmail(supabase, { templateKey, recipientEmail, recipientId, subject: templateKey, status: 'failed', error: 'Template not found', metadata });
    return { ok: false, skipped: false, error: 'Template not found' };
  }

  if (!tmpl.enabled) {
    await logEmail(supabase, { templateKey, recipientEmail, recipientId, subject: tmpl.subject, status: 'skipped', metadata });
    return { ok: true, skipped: true };
  }

  // ── 2. Load global settings ───────────────────────────────────────────────
  const { data: settings } = await supabase
    .from('email_settings')
    .select('*')
    .single();

  const fromName  = settings?.from_name  ?? 'OneShetland';
  const fromEmail = settings?.from_email ?? 'orders@oneshetland.com';

  // ── 3. Interpolate {{variables}} ──────────────────────────────────────────
  const subject  = interpolate(tmpl.subject,   variables);
  const bodyHtml = interpolateHtml(tmpl.body_html, variables); // values HTML-escaped
  const bodyText = tmpl.body_text ? interpolate(tmpl.body_text, variables) : htmlToText(bodyHtml);

  // ── 4. Build footer HTML ──────────────────────────────────────────────────
  const footer = buildFooter(settings);
  const fullHtml = wrapEmail(fromName, subject, bodyHtml, footer);

  // ── 5. Send via Postmark ──────────────────────────────────────────────────
  const apiKey = Deno.env.get('POSTMARK_API_KEY') ?? '';
  if (!apiKey) {
    console.error('[send-email] POSTMARK_API_KEY not set');
    await logEmail(supabase, { templateKey, recipientEmail, recipientId, subject, status: 'failed', error: 'POSTMARK_API_KEY not configured', metadata });
    return { ok: false, skipped: false, error: 'POSTMARK_API_KEY not configured' };
  }

  const stream = tmpl.postmark_stream ?? 'outbound';

  let postmarkId: string | undefined;
  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method:  'POST',
      headers: {
        'Accept':                  'application/json',
        'Content-Type':            'application/json',
        'X-Postmark-Server-Token': apiKey,
      },
      body: JSON.stringify({
        From:          `${fromName} <${fromEmail}>`,
        To:            recipientEmail,
        ReplyTo:       settings?.reply_to ?? fromEmail,
        Subject:       subject,
        HtmlBody:      fullHtml,
        TextBody:      bodyText,
        MessageStream: stream,
        TrackOpens:    true,
        TrackLinks:    'None',
        Metadata:      { template_key: templateKey, ...metadata },
      }),
    });

    const json = await res.json() as { MessageID?: string; ErrorCode?: number; Message?: string };

    if (!res.ok || json.ErrorCode) {
      throw new Error(json.Message ?? `Postmark error ${json.ErrorCode}`);
    }

    postmarkId = json.MessageID;
    await logEmail(supabase, { templateKey, recipientEmail, recipientId, subject, status: 'sent', postmarkId, metadata });
    return { ok: true, skipped: false, postmark_id: postmarkId };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[send-email] Postmark error for ${templateKey}:`, message);
    await logEmail(supabase, { templateKey, recipientEmail, recipientId, subject, status: 'failed', error: message, metadata });
    return { ok: false, skipped: false, error: message };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/** Escape a value for safe insertion into HTML. */
function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow http(s) URLs in href attributes (blocks javascript:/data: URIs). */
function safeUrl(u: unknown): string {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

/** Like interpolate(), but HTML-escapes each value — for the HTML body only.
 *  EXCEPTION: keys ending in `_html` are already pre-rendered, trusted HTML
 *  (built server-side from already-escaped pieces, e.g. the gift message block),
 *  so they're inserted raw — otherwise the markup shows as literal tags. */
function interpolateHtml(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v == null) return `{{${key}}}`;
    return key.endsWith('_html') ? String(v) : escapeHtml(v);
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function buildFooter(settings: Record<string, unknown> | null): string {
  if (!settings) return '';
  const parts: string[] = [];
  if (settings.footer_sign_off)  parts.push(`<p style="margin:0">${escapeHtml(settings.footer_sign_off)}</p>`);
  if (settings.footer_signature) parts.push(`<p style="margin:4px 0 0"><strong>${escapeHtml(settings.footer_signature)}</strong></p>`);
  if (settings.footer_tagline)   parts.push(`<p style="margin:4px 0 0;color:#6B7280;font-size:13px">${escapeHtml(settings.footer_tagline)}</p>`);
  if (settings.footer_promo_text && settings.footer_promo_url) {
    parts.push(`<p style="margin:16px 0 0"><a href="${safeUrl(settings.footer_promo_url)}" style="color:#032F4C;font-weight:700">${escapeHtml(settings.footer_promo_text)}</a></p>`);
  }
  const socials = Array.isArray(settings.footer_socials) ? settings.footer_socials as Array<{label:string;url:string}> : [];
  if (socials.length > 0) {
    const links = socials.map(s => `<a href="${safeUrl(s.url)}" style="color:#032F4C;margin-right:12px">${escapeHtml(s.label)}</a>`).join('');
    parts.push(`<p style="margin:12px 0 0">${links}</p>`);
  }
  if (settings.footer_legal) {
    parts.push(`<p style="margin:16px 0 0;color:#9CA3AF;font-size:12px">${escapeHtml(settings.footer_legal)}</p>`);
  }
  return parts.join('\n');
}

function wrapEmail(fromName: string, subject: string, body: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr>
          <td style="background:#032F4C;padding:24px 32px;border-radius:12px 12px 0 0">
            <p style="margin:0;color:#12B3D6;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">ONESHETLAND</p>
            <p style="margin:4px 0 0;color:#fff;font-size:20px;font-weight:800">${subject}</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:32px;color:#0F1C26;font-size:15px;line-height:24px">
            ${body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#F9FAFB;padding:24px 32px;border-top:1px solid #E5E9EF;border-radius:0 0 12px 12px;font-size:14px;color:#374151;line-height:22px">
            ${footer}
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function logEmail(
  supabase: SupabaseClient,
  entry: {
    templateKey:    string;
    recipientEmail: string;
    recipientId?:   string | null;
    subject:        string;
    status:         string;
    postmarkId?:    string;
    error?:         string;
    metadata?:      Record<string, unknown>;
  },
) {
  try {
    await supabase.from('email_log').insert({
      template_key:    entry.templateKey,
      recipient_id:    entry.recipientId ?? null,
      recipient_email: entry.recipientEmail,
      subject:         entry.subject,
      status:          entry.status,
      postmark_id:     entry.postmarkId ?? null,
      error_message:   entry.error ?? null,
      metadata:        entry.metadata ?? {},
    });
  } catch (e) {
    console.warn('[send-email] Failed to write email_log:', e);
  }
}
