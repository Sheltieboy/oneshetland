/**
 * Peerie Bot — the OneShetland AI assistant (app side).
 *
 * Mirrors `lib/peerie.ts` on the web so the assistant is the same character in
 * both places: same name, same ✨, same AI tag, same ring colours for the
 * "working" glow. Keep the two in step — if the web copy changes, change this.
 *
 * The parsing itself lives on the web (`/api/ai/parse-*`), because the
 * ANTHROPIC_API_KEY must stay server-side and the prompts are already tuned
 * there. The app posts plain English to those same endpoints, so there is one
 * prompt per form for the whole ecosystem rather than two that drift apart.
 */

export const PEERIE = {
  name: 'Peerie Bot',
  role: 'AI assistant',
  /** Always shown with the name so it reads as AI, not a person. */
  tag: 'AI',
  spark: '✨',
} as const;

/** The OneShetland rings palette — drives the working glow. */
export const RING_COLOURS = [
  '#12B3D6', // spik cyan
  '#7C3AED', // cruise violet
  '#E8A020', // what's-on amber
  '#10B981', // games emerald
  '#E0722A', // local orange
  '#4F46E5', // directory indigo
  '#EC4899', // pink
];

/**
 * Where the parse endpoints live. Overridable for dev against a local Next
 * server (EXPO_PUBLIC_WEB_BASE_URL=http://192.168.x.x:3000).
 */
export const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? 'https://oneshetland.com';

export const PEERIE_ENDPOINTS = {
  event: `${WEB_BASE_URL}/api/ai/parse-event`,
  job: `${WEB_BASE_URL}/api/ai/parse-job`,
  shift: `${WEB_BASE_URL}/api/ai/parse-shift`,
} as const;
