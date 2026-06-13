/**
 * constants/nav.ts
 *
 * The app's canonical navigation + motion presets. Spread these into
 * `Stack.Screen` options so every transition of the same kind behaves
 * identically. (Design language A1/A2.)
 *
 *   SCREEN_PUSH   — drilling DEEPER into a section (detail / multi-step).
 *                   Horizontal push, swipe-from-edge back.
 *   MODAL_PRESENT — a focused CREATE / checkout task. Full-cover, slides up,
 *                   explicit Close/X, no section chrome.
 *   SHEET_PRESENT — a route-level bottom sheet (short contextual task).
 *   SECTION_ROOT  — a SECTION you switch TO (tab/sidebar landing). No back
 *                   gesture, no push animation — it's a replacement, not a drill-down.
 *
 * In-component pop-ups use <Sheet> (components/ui/Sheet) — the RN-modal
 * equivalent of SHEET_PRESENT.
 */

/** Drill deeper into a section — detail screens, multi-step flows. */
export const SCREEN_PUSH = {
  animation: 'slide_from_right',
  gestureEnabled: true,
} as const;

/** Focused create / checkout — covers everything, slides up, X to leave. */
export const MODAL_PRESENT = {
  presentation: 'modal',
  animation: 'slide_from_bottom',
  gestureEnabled: true,
} as const;

/** Route-level bottom sheet — short contextual task, swipe-down to dismiss. */
export const SHEET_PRESENT = {
  presentation: 'formSheet',
  animation: 'slide_from_bottom',
  sheetGrabberVisible: true,
  sheetCornerRadius: 28,
  gestureEnabled: true,
} as const;

/** A section you switch TO (tab/sidebar landing) — no drill-in, no back gesture. */
export const SECTION_ROOT = {
  animation: 'none',
  gestureEnabled: false,
} as const;
