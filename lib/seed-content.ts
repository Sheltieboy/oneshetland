/**
 * lib/seed-content.ts
 *
 * Placeholder sample data for Events, Notices and Jobs while their
 * real schemas are being built. Lets the Home concierge render
 * end-to-end immediately. Each section's real fetcher should drop in
 * here once the DB is live (chunk B) — same shape, different source.
 *
 * NOTE: these are illustrative samples — fictitious posters, generic
 * Shetland-flavoured content — meant to set the visual habit. Don't
 * leave them on after the real data tables are populated.
 */

export interface SampleEvent {
  id:          string;
  title:       string;
  starts_at:   string;      // ISO
  venue:       string;
  category:    string;
  cover_url?:  string | null;
  is_featured?: boolean;
  price_text?:  string | null;
  has_tickets?: boolean;
}

export interface SampleNotice {
  id:        string;
  severity:  'urgent' | 'community' | 'info';
  title:     string;
  body:      string;
  locality:  string | null;        // free-text, e.g. "Lerwick", "All Shetland"
  posted_at: string;
  publisher: string;               // who put it out
}

export interface SampleJob {
  id:        string;
  title:     string;
  employer:  string;
  location:  string;
  pay:       string;
  posted_at: string;
}

export interface SampleShift {
  id:        string;
  title:     string;
  employer:  string;
  when:      string;               // human "Tonight 6-11 pm"
  pay:       string;
}

const DAY = 86_400_000;

function isoOffset(daysFromNow: number, hour = 18): string {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ── Events ─────────────────────────────────────────────────────────────────

export const SAMPLE_EVENTS: SampleEvent[] = [
  { id: 'e1', title: 'Folk Festival opening night',    starts_at: isoOffset(2, 19), venue: 'Mareel, Lerwick',         category: 'Music' },
  { id: 'e2', title: 'Hay\'s Dock farmers\' market',   starts_at: isoOffset(3, 10), venue: 'Hay\'s Dock, Lerwick',    category: 'Market' },
  { id: 'e3', title: 'Sandwick boat-jumble',           starts_at: isoOffset(4, 11), venue: 'Sandwick Community Hall', category: 'Community' },
  { id: 'e4', title: 'Up Helly Aa fundraiser ceilidh', starts_at: isoOffset(5, 20), venue: 'Brae Hall',               category: 'Music' },
  { id: 'e5', title: 'Wildlife walk — Eshaness',       starts_at: isoOffset(6, 14), venue: 'Eshaness car park',       category: 'Outdoors' },
];

// ── Notices ────────────────────────────────────────────────────────────────

export const SAMPLE_NOTICES: SampleNotice[] = [
  {
    id: 'n1',
    severity: 'community',
    title: 'Yell ferry — Tuesday evening sailings cancelled',
    body: 'Heavy swell forecast. The 18:00 and 21:00 sailings from Toft will not run; check NorthLink for updates.',
    locality: 'Yell',
    posted_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    publisher: 'SIC Ferries',
  },
  {
    id: 'n2',
    severity: 'community',
    title: 'Found — black labrador, Hillswick',
    body: 'Friendly, no collar. Currently at the shop. Ring on 0xxx if she\'s yours.',
    locality: 'Hillswick',
    posted_at: new Date(Date.now() - 10 * 3600_000).toISOString(),
    publisher: 'Joanna Williamson',
  },
  {
    id: 'n3',
    severity: 'info',
    title: 'Library hours change',
    body: 'The Lerwick library is closed all day Thursday for a staff training day.',
    locality: 'Lerwick',
    posted_at: new Date(Date.now() - 26 * 3600_000).toISOString(),
    publisher: 'Shetland Library',
  },
];

/**
 * If you want to simulate an urgent banner for development, change
 * the first entry's severity to 'urgent'. Real urgent notices will
 * only come from verified business publishers with the
 * can_publish_urgent flag set (chunk B).
 */
export const SAMPLE_URGENT_NOTICE: SampleNotice | null = null;

// ── Jobs ───────────────────────────────────────────────────────────────────

export const SAMPLE_JOBS: SampleJob[] = [
  { id: 'j1', title: 'Boat-yard apprentice', employer: 'Hamnavoe Boats',     location: 'Hamnavoe',  pay: '£24–28k',     posted_at: new Date().toISOString() },
  { id: 'j2', title: 'Café manager',         employer: 'Da Kitchen',         location: 'Lerwick',   pay: '£28k',        posted_at: new Date().toISOString() },
];

// ── Shifts ─────────────────────────────────────────────────────────────────

export const SAMPLE_SHIFTS: SampleShift[] = [
  { id: 's1', title: 'Bar cover',    employer: 'The Lounge',    when: 'Tonight 6 – 11 pm', pay: '£13.50/hr' },
  { id: 's2', title: 'Net mending',  employer: 'Sandwick Pier', when: 'Sat morning',       pay: 'Negotiable' },
];

// ── Spik daily word ────────────────────────────────────────────────────────
//
// In chunk B this will be replaced with a deterministic-by-date pick
// from spik_dictionary. For the shell, a tiny static rotation through
// a handful of universal Shetland words by day-of-month.

const SPIK_DAILY: { word: string; meaning: string }[] = [
  { word: 'peerie',   meaning: 'small, tiny'                              },
  { word: 'voe',      meaning: 'sea inlet (Norn-rooted)'                  },
  { word: 'haaf',     meaning: 'the deep, open sea'                       },
  { word: 'simmer',   meaning: 'summer; lingering summer light'           },
  { word: 'da',       meaning: 'the (definite article)'                   },
  { word: 'wir',      meaning: 'our'                                      },
  { word: 'shoormal', meaning: 'the line where the sea meets the shore'   },
  { word: 'auld',     meaning: 'old'                                      },
  { word: 'noost',    meaning: 'a hollow above the shore to lay a boat in'},
  { word: 'simmer dim', meaning: 'the never-quite-dark night of June'     },
];

export function todaysSpik(): { word: string; meaning: string } {
  const idx = (new Date().getDate() - 1) % SPIK_DAILY.length;
  return SPIK_DAILY[idx];
}
