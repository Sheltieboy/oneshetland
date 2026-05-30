/**
 * oneshetland-api.ts
 *
 * Fetches data from the OneShetland WordPress REST API.
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export interface OSEvent {
  id: number;
  title: string;
  url: string;
  start_date: string;
  end_date: string;
  venue: string | null;
  image: string | null;
  description: string;
}

export interface OSJob {
  id: number;
  title: string;
  url: string;
  company: string | null;
  location: string | null;
  type: string | null;
  posted: string;
  image: string | null;
}

export interface OSNotice {
  id: number;
  title: string;
  url: string;
  excerpt: string;
  posted: string;
  image: string | null;
}

export interface OSSpikWord {
  id: number;
  word: string;
  definition: string;       // short_meaning → spik_meaning fallback
  example: string | null;   // example_sentence
  category: string | null;  // category
  part_of_speech: string | null; // part_of_speech
}

export interface OSHomeFeed {
  events: OSEvent[];
  jobs: OSJob[];
  notices: OSNotice[];
  spik_word: OSSpikWord | null;
}

export async function fetchHomeFeed(): Promise<OSHomeFeed> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/oneshetland_feed?id=eq.1&select=data`,
    {
      headers: {
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  const rows = await res.json();
  if (!rows?.[0]?.data) throw new Error('Feed data not available');
  return rows[0].data as OSHomeFeed;
}

// ── Spik Dictionary ──────────────────────────────────────────────────────────

export interface SpikEntry {
  id: number;
  word: string;
  first_letter: string | null;
  alternate_spelling: string | null;
  pronunciation: string | null;
  short_meaning: string | null;
  spik_meaning: string | null;
  example_sentence: string | null;
  part_of_speech: string | null;
  category: string | null;
  usage_level: string | null;
  era: string | null;
  tone: string | null;
  origin: string | null;
  audio_url: string | null;
  contributor_name: string | null;
  contributor_show: boolean | null;
  speaker_area: string | null;
  notes: string | null;
}

export type SpikListItem = Pick<
  SpikEntry,
  'id' | 'word' | 'part_of_speech' | 'short_meaning' | 'pronunciation' | 'example_sentence'
>;

const SPIK_SELECT_LIST = 'id,word,part_of_speech,short_meaning,pronunciation,example_sentence';

export async function fetchSpikByLetter(letter: string): Promise<SpikListItem[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/spik_dictionary?first_letter=eq.${encodeURIComponent(letter)}&order=word.asc&select=${SPIK_SELECT_LIST}`,
    {
      headers: {
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function searchSpik(query: string): Promise<SpikListItem[]> {
  const q = encodeURIComponent(`*${query}*`);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/spik_dictionary?word=ilike.${q}&order=word.asc&select=${SPIK_SELECT_LIST}&limit=60`,
    {
      headers: {
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface SpikStats {
  total: number;
  origins: Array<{ origin: string; count: number }>;
  usage:   Array<{ level: string;  count: number }>;
}

export async function fetchSpikStats(): Promise<SpikStats> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/get_spik_stats`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: '{}',
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Spik words filtered by an origin value (e.g. 'scots', 'old norse'). */
export async function fetchSpikByOrigin(origin: string): Promise<SpikListItem[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/spik_dictionary?origin=eq.${encodeURIComponent(origin)}&order=word.asc&select=${SPIK_SELECT_LIST}&limit=500`,
    {
      headers: {
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Spik words filtered by usage_level (e.g. 'less common', 'common'). */
export async function fetchSpikByUsage(level: string): Promise<SpikListItem[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/spik_dictionary?usage_level=eq.${encodeURIComponent(level)}&order=word.asc&select=${SPIK_SELECT_LIST}&limit=500`,
    {
      headers: {
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSpikEntry(id: number): Promise<SpikEntry> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/spik_dictionary?id=eq.${id}&select=*`,
    {
      headers: {
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!rows?.[0]) throw new Error('Word not found');
  return rows[0] as SpikEntry;
}

/** Format event date range nicely e.g. "11–14 Jun" or "Today" */
export function formatEventDate(startDate: string): string {
  const date = new Date(startDate);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Decode HTML entities in WordPress title strings */
export function decodeEntities(str: string): string {
  return str
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&amp;/g, '&')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ');
}
