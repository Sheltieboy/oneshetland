/**
 * editions-email-templates.ts — pure rendering of the Editions transactional emails. No network, no secrets; tested with Node.
 * Rules: plain, short, one clear next step, no tracking, no marketing, every message says why the person is receiving it. Text is escaped for HTML and the subject can
 * never be forged by a name or title (header injection). Money is shown from integer pence. Links are built only from the configured site origin and fixed paths.
 */
export type OutboxRow = { id: number; kind: string; user_id: string; email: string; payload: Record<string, unknown>; attempts: number };
export type Rendered = { subject: string; text: string; html: string };

const s = (v: unknown, max = 120): string => (typeof v === 'string' ? v.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pounds = (p: unknown) => (typeof p === 'number' && Number.isInteger(p) ? `£${(p / 100).toFixed(2)}` : '');
const day = (iso: unknown) => { const d = typeof iso === 'string' ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(d) : ''; };

type Spec = { subject: string; lines: string[]; cta: { label: string; path: string }; why: string };

export function renderEditionEmail(row: Pick<OutboxRow, 'kind' | 'payload'>, origin: string): Rendered | null {
  const p = row.payload ?? {};
  const org = s(p.organiser_name), ed = s(p.edition_title), name = s(p.subject_name), tier = s(p.tier_name), biz = s(p.business_name), label = s(p.label);
  const base = origin.replace(/\/+$/, '');
  const S = (x: Spec): Rendered => {
    const url = `${base}${x.cta.path}`;
    const text = [...x.lines, '', `${x.cta.label}: ${url}`, '', x.why, 'OneShetland Editions'].join('\n');
    const html = `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#10222e;line-height:1.5;max-width:34rem;margin:0 auto;padding:1.25rem">${x.lines.map((l) => `<p style="margin:0 0 .9rem">${esc(l)}</p>`).join('')}<p style="margin:1.4rem 0"><a href="${esc(url)}" style="background:#032f4c;color:#fff;padding:.7rem 1.2rem;border-radius:999px;text-decoration:none;font-weight:600">${esc(x.cta.label)}</a></p><p style="color:#5b6b75;font-size:.85rem;margin:1.4rem 0 0">${esc(x.why)}</p></body></html>`;
    return { subject: s(x.subject, 150), text, html };
  };
  const mgr = p.subject_kind === 'hub' ? 'You are receiving this because you help run this Hub on OneShetland.' : 'You are receiving this because you manage this listing on OneShetland.';
  const biz_ = '/account/editions'; const org_ = (suffix: string) => `/organise/${s(p.organiser_slug, 80)}${suffix}`;
  switch (row.kind) {
    case 'partner_invited': return S({ subject: `${org} has invited ${name} to take part in ${ed}`, lines: [`${org} would like ${name} to take part in ${ed}.`, 'You decide whether to say yes, what is shown, and you can step back at any time. Nothing appears until you agree.'], cta: { label: 'See the invitation', path: biz_ }, why: mgr });
    case 'partner_requested': return S({ subject: `${name} has asked to take part in ${ed}`, lines: [`${name} has asked to be part of ${ed}.`, 'Open your Partners page to welcome them or decline.'], cta: { label: 'Review the request', path: p.organiser_slug ? org_('') : '/organise' }, why: `You are receiving this because you are an organiser admin for ${org}.` });
    case 'partner_answered': return S({ subject: `${name} ${p.answer === 'approved' ? 'is taking part in' : 'has declined'} ${ed}`, lines: [p.answer === 'approved' ? `${name} has said yes to taking part in ${ed}.` : `${name} has said no to taking part in ${ed} this time.`], cta: { label: 'Open Partners', path: '/organise' }, why: `You are receiving this because you are an organiser admin for ${org}.` });
    case 'partner_request_answered': return S({ subject: p.answer === 'approved' ? `${org} has welcomed ${name} to ${ed}` : `${org} has answered your request about ${ed}`, lines: [p.answer === 'approved' ? `${org} has said yes: ${name} is part of ${ed}. Check whether anything is needed to complete your place.` : `${org} is not able to include ${name} in ${ed} this time.`], cta: { label: 'See your Editions', path: biz_ }, why: mgr });
    case 'partner_withdrew': return S({ subject: `${name} has stepped back from ${ed}`, lines: [`${name} has taken itself out of ${ed}. It no longer appears on your Edition.`], cta: { label: 'Open Partners', path: '/organise' }, why: `You are receiving this because you are an organiser admin for ${org}.` });
    case 'partner_removed': return S({ subject: `${name} has been removed from ${ed}`, lines: [`${org} has removed ${name} from ${ed}. Your own listing, plan and offers are unchanged.`], cta: { label: 'See your Editions', path: biz_ }, why: mgr });
    case 'membership_invited': return S({ subject: `${org} has invited ${biz} to join as a ${tier}`, lines: [`${org} would like ${biz} to join as a ${tier}.`, 'You can say yes or no, and cancel any time. Joining never changes your listing, plan or offers.'], cta: { label: 'See the invitation', path: biz_ }, why: 'You are receiving this because you manage this business on OneShetland.' });
    case 'membership_applied': return S({ subject: `${biz} has applied to join as a ${tier}`, lines: [`${biz} has applied for the ${tier} membership.`], cta: { label: 'Review applications', path: '/organise' }, why: `You are receiving this because you are an organiser admin for ${org}.` });
    case 'membership_approved': return S({ subject: `Your ${tier} application was approved`, lines: [`${org} has approved ${biz} for the ${tier} membership.`, 'The next step is to complete payment, if there is a fee, so your membership can start.'], cta: { label: 'Complete your membership', path: biz_ }, why: 'You are receiving this because you applied on behalf of this business.' });
    case 'membership_declined': return S({ subject: `Your ${tier} application`, lines: [`${org} was not able to accept ${biz} as a ${tier} this time.`], cta: { label: 'See your memberships', path: biz_ }, why: 'You are receiving this because you applied on behalf of this business.' });
    case 'membership_welcome': return S({ subject: `Welcome: ${biz} is now a ${tier}`, lines: [`${biz} is now a ${tier} of ${org}.`, p.period_end ? `Your current period runs to ${day(p.period_end)}.` : ''], cta: { label: 'See your membership', path: biz_ }, why: 'You are receiving this because you manage this business on OneShetland.' });
    case 'membership_payment_failed': return S({ subject: `Your ${tier} payment did not go through`, lines: [`We could not take the payment for ${biz}'s ${tier} membership of ${org}.`, 'Please update your payment details soon so your benefits are not interrupted.'], cta: { label: 'Update payment', path: biz_ }, why: 'You are receiving this because you manage this business on OneShetland.' });
    case 'membership_expired': return S({ subject: `Your ${tier} membership has ended`, lines: [`${biz}'s ${tier} membership of ${org} has ended because the payment was not completed.`, 'You can join again at any time.'], cta: { label: 'See your memberships', path: biz_ }, why: 'You are receiving this because you manage this business on OneShetland.' });
    case 'membership_ended': return S({ subject: `Your ${tier} membership has ended`, lines: [`${org} has ended ${biz}'s ${tier} membership.`, s(p.note, 300) ? `Their note: ${s(p.note, 300)}` : ''], cta: { label: 'See your memberships', path: biz_ }, why: 'You are receiving this because you manage this business on OneShetland.' });
    case 'membership_renewal_30d':
    case 'membership_renewal_7d': return S({ subject: `Your ${tier} membership renews ${row.kind.endsWith('7d') ? 'soon' : 'next month'}`, lines: [`${biz}'s ${tier} membership of ${org} runs to ${day(p.period_end)}.`, `${org} will be in touch about renewing, or you can contact them directly.`], cta: { label: 'See your membership', path: biz_ }, why: 'You are receiving this because you manage this business on OneShetland.' });
    case 'payment_receipt': return S({ subject: `Receipt: ${pounds(p.charge_pence)} to ${org}`, lines: [`Thank you. ${biz} paid ${pounds(p.charge_pence)} to ${org}${label ? ` for ${label}` : ''}.`, Number(p.vat_pence) > 0 ? `This includes VAT of ${pounds(p.vat_pence)}.` : '', s(p.legal_name) ? `Supplier: ${s(p.legal_name)}${s(p.vat_number) ? ` (VAT no. ${s(p.vat_number)})` : ''}.` : ''], cta: { label: 'See your payments', path: biz_ }, why: 'You are receiving this receipt because a payment was made for this business on OneShetland.' });
    default: return null;
  }
}
export const EMAIL_KINDS = ['partner_invited', 'partner_requested', 'partner_answered', 'partner_request_answered', 'partner_withdrew', 'partner_removed', 'membership_invited', 'membership_applied', 'membership_approved', 'membership_declined', 'membership_welcome', 'membership_payment_failed', 'membership_expired', 'membership_ended', 'membership_renewal_30d', 'membership_renewal_7d', 'payment_receipt'] as const;
