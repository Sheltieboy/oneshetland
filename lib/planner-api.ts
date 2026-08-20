/**
 * Day planner — app side.
 *
 * The planner itself is NOT reimplemented here, and that is the whole design.
 * A planner has to be right about times, and two implementations of "how long
 * does it take to get from Lerwick to Weisdale, and is it open when you get
 * there" would drift apart within a month of either being touched. So the app
 * posts the same request the website's own page makes to the same endpoint,
 * and renders what comes back.
 *
 * One difference, and it's deliberate: the website renders a deterministic
 * plan first and then asks Peerie Bot to improve it, so a model failure there
 * costs nothing — it keeps what's on screen. The app asks cold, so it sends
 * `allowPlain` and the server falls back to the plain planner rather than
 * handing back an error. Either way the user gets a day; `by` says which.
 */

import { WEB_BASE_URL } from '@/constants/peerie';
import { peerieHeaders } from '@/lib/peerie-auth';

export type Interest = 'food' | 'shops' | 'history' | 'outdoors' | 'music' | 'family';

/** Mirrors INTERESTS in the web's lib/planner.ts — keep the two in step. */
export const INTERESTS: { key: Interest; label: string; emoji: string }[] = [
  { key: 'food',     label: 'Food & drink',      emoji: '🍽' },
  { key: 'shops',    label: 'Shops & makers',    emoji: '🧶' },
  { key: 'history',  label: 'History & culture', emoji: '🏛' },
  { key: 'outdoors', label: 'Outdoors',          emoji: '🥾' },
  { key: 'music',    label: 'Music & events',    emoji: '🎵' },
  { key: 'family',   label: 'Family',            emoji: '👨‍👩‍👧' },
];

export type Transport = 'driving' | 'walking';

export type PlanStop = {
  id: string;
  name: string;
  href: string;
  image: string | null;
  blurb: string | null;
  kind: string;
  startsAt: string | null;
  arrive: string;
  depart: string;
  travel: string;
  travelMode: Transport;
  /** False when nobody has told us the opening hours — shown, never hidden. */
  openKnown: boolean;
  why: string | null;
  lat: number;
  lng: number;
};

export type DayPlan = {
  /** 'peerie' when Peerie Bot chose the order, 'plain' when the code did. */
  by: 'peerie' | 'plain';
  title: string;
  intro: string | null;
  stops: PlanStop[];
  skipped: { name: string; reason: string }[];
};

export type PlanRequest = {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  from: string;
  to: string;
  transport: Transport;
  interests: Interest[];
};

/**
 * Peerie Bot can take the best part of twenty seconds on a busy day, and the
 * server has its own 20s budget before it gives up and returns the plain plan.
 * 45s leaves room for that plus a slow island connection without the app
 * abandoning a request the server is about to answer.
 */
const TIMEOUT_MS = 45_000;

export async function fetchDayPlan(req: PlanRequest): Promise<DayPlan> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${WEB_BASE_URL}/api/ai/plan-day`, {
      method: 'POST',
      headers: await peerieHeaders(),
      body: JSON.stringify({ ...req, allowPlain: true }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(readableError(data?.error, res.status));
    if (!Array.isArray(data?.stops) || data.stops.length === 0) {
      throw new Error(readableError('nothing fits', 503));
    }
    return {
      by: data.by === 'peerie' ? 'peerie' : 'plain',
      title: typeof data.title === 'string' ? data.title : 'Your day',
      intro: typeof data.intro === 'string' ? data.intro : null,
      stops: data.stops as PlanStop[],
      skipped: Array.isArray(data.skipped) ? data.skipped : [],
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('That took too long. Try a shorter day, or have another go in a minute.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The server's error strings are for the log, not for somebody standing in the
 * rain wondering where to go. Every one of these is a dead end the user can do
 * something about, so each says what to change.
 */
function readableError(code: unknown, status: number): string {
  switch (code) {
    case 'nothing fits':
    case 'too thin':
      return "We couldn't fill that day — try a longer window, or pick a few more interests.";
    case 'bad window':
      return 'The finish time needs to be after the start time.';
    case 'date required':
      return 'Pick a day first.';
    default:
      // Peerie Bot is a signed-in feature with a usage ceiling now, and both
      // of those deserve a real sentence rather than "something went wrong".
      if (status === 401) return 'Sign in to let Peerie Bot plan your day.';
      if (status === 429) return "You've used Peerie Bot a lot in a short time. Give it a few minutes and try again.";
      if (status === 413) return "That's a bit much for Peerie Bot to read — try a shorter day.";
      return status >= 500
        ? "We couldn't build a day just now. Have another go in a minute."
        : 'Something went wrong building your day.';
  }
}

/**
 * What to say while Peerie Bot is thinking.
 *
 * Word-for-word the web's progressSteps() (components/visiting/PlanUpgrade.tsx)
 * — keep the two in step. A twenty-second wait behind one frozen "putting your
 * day together…" reads as a hang; the same wait narrated reads as work, and
 * naming what it's doing with the user's OWN answers ("looking for history and
 * food", "fitting it into 10:00 to 17:00") also shows it heard them.
 */
export function progressSteps(q: {
  from: string; to: string; transport: Transport; interests: Interest[];
}): string[] {
  const wanted = q.interests
    .map(k => INTERESTS.find(i => i.key === k)?.label.toLowerCase())
    .filter(Boolean) as string[];

  const list =
    wanted.length === 0 ? 'a bit of everything'
    : wanted.length === 1 ? wanted[0]
    : `${wanted.slice(0, -1).join(', ')} and ${wanted[wanted.length - 1]}`;

  return [
    'Reading your search…',
    `Looking for ${list}…`,
    "Checking what's open while you're here…",
    q.transport === 'walking'
      ? 'Working out what\'s within walking distance…'
      : 'Working out the drive between each stop…',
    `Fitting it into ${q.from} to ${q.to}…`,
    'Putting them in an order that makes sense…',
    'Nearly there…',
  ];
}

/** How long each line holds before the next — matches the web. */
export const PROGRESS_STEP_MS = 1900;

/** YYYY-MM-DD in LOCAL time — toISOString() would roll over an evening. */
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** HH:MM in local time. */
export function hhmm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Thursday 20 August" — for the plan header. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
