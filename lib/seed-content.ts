/**
 * lib/seed-content.ts
 *
 * The one piece of built-in content the app keeps: a small rotation of genuine Shetland dialect words, used as the
 * word of the day only if the live dictionary (spik_daily) cannot be reached.
 *
 * Sample events, notices, jobs and shifts that used to live here were removed: they were illustrative placeholders
 * (including a made-up "TONIGHT Bar cover £13.50/hr" shift) that the Home screen showed whenever a real table was empty.
 * The app now shows only real data and collapses a section when there is none.
 */

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
