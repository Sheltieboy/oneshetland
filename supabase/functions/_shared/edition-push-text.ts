/**
 * edition-push-text.ts — the words and the data of every Editions push, in one place so they can be tested.
 *
 * RULES (app-store compliance and privacy): no price, buying, package or promotion wording in any notification; no personal data (no names, addresses, reviewer notes) — only
 * ids/slugs the app needs to open a screen; text taken from the database row, never from the request. Followers' pushes open the public Edition screen (edition_slug); organiser pushes
 * carry no route on purpose: the Edition may not be public yet, so the tap opens the app and the item waits in the notification centre.
 */

export const clean = (s: unknown, max: number): string =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export interface PushMessage { title: string; body: string; data: Record<string, unknown>; categoryId: string }

export function followerUpdateMessage(c: { edition_id: string; edition_slug: string; edition_title: string; update_title: string }, updateId: string): PushMessage {
  return {
    title: clean(c.edition_title, 80) || 'An Edition you saved',
    body: clean(c.update_title, 120) || 'There is a new update',
    categoryId: 'editions.update',
    data: { edition_slug: c.edition_slug, edition_id: c.edition_id, edition_update_id: updateId },
  };
}

export const ORGANISER_KINDS = ['edition_approved', 'edition_changes_requested', 'edition_rejected', 'package_active'] as const;
export type OrganiserKind = typeof ORGANISER_KINDS[number];

const ORGANISER_BODY: Record<OrganiserKind, string> = {
  edition_approved: 'Good news: it has been approved.',
  edition_changes_requested: 'A few changes are needed before it can be approved.',
  edition_rejected: 'It could not be approved this time. Details are in your email.',
  package_active: 'It is set up and ready to publish.',
};

export function organiserMessage(kind: string, editionTitle: string): PushMessage | null {
  if (!(ORGANISER_KINDS as readonly string[]).includes(kind)) return null;
  return {
    title: clean(editionTitle, 80) || 'Your Edition',
    body: ORGANISER_BODY[kind as OrganiserKind],
    categoryId: `editions.${kind}`,
    data: { topic: 'edition_organiser', event: kind },
  };
}
