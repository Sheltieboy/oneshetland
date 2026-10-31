/**
 * Homepage dismissal of the Essential Alert strip. PRESENTATION ONLY: nothing here touches the notice, its status, the Notices list or
 * any notification preference. State is a per-device list of dismissed notice ids (never a global switch):
 *   - dismissing hides every alert that is active right now from the Home strip;
 *   - an alert published later has a new id, so the strip comes back for it;
 *   - a dismissed alert never returns to the strip.
 */
export const DISMISSED_KEY = 'os.essentialAlertsDismissed.v1';
const MAX_KEPT = 200;

/** Parse whatever storage returned into a clean id list; anything malformed is an empty list (the strip simply shows). */
export function parseDismissed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(-MAX_KEPT) : [];
  } catch { return []; }
}

/** The alerts still eligible for the strip: those whose id has not been dismissed. Order is preserved. */
export function undismissed<T extends { id: string }>(alerts: readonly T[] | null | undefined, dismissed: readonly string[]): T[] {
  const gone = new Set(dismissed);
  return (alerts ?? []).filter((a) => !gone.has(a.id));
}

/** The new dismissed list after the user dismisses the strip: every alert currently shown (the whole active set) is added. */
export function dismissAll(dismissed: readonly string[], active: readonly { id: string }[]): string[] {
  const next = [...dismissed];
  for (const a of active) if (!next.includes(a.id)) next.push(a.id);
  return next.slice(-MAX_KEPT);
}
