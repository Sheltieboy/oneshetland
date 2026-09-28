/**
 * constants/shetland-areas.ts
 *
 * The one mobile source of truth for "where in Shetland" pickers — used by
 * app/onboarding.tsx and app/edit-profile.tsx, which each used to carry
 * their own copy of this list, drifted from each other and from web's own
 * (also duplicated) copy in oneshetland-web/lib/onboarding.ts and
 * components/account/ProfileEditForm.tsx.
 *
 * Reconciled from BOTH the mobile and web lists as they stood before this
 * file existed — nothing legitimate dropped from either side:
 *   - kept every mobile-only area (Laxo, Sullom, Levenwick, Sumburgh, Boddam)
 *   - added every web-only area (Aith, Nesting, Toft, North Roe, Burra, Trondra)
 *   - merged the one same-place naming split: mobile's "Skerries" and web's
 *     "Out Skerries" become "Out Skerries" (the fuller, standard name)
 *
 * Web is NOT updated in this task — its own two lists are untouched, and are
 * a natural candidate for a follow-up reconciliation pass so all three copies
 * (this file plus web's two) read from one place, but that's out of scope
 * here.
 *
 * The 36 real places are alphabetised A–Z, so both pickers (and their search
 * field) read as a normal sorted list. The final entry, "Other / elsewhere in
 * Shetland", is a deliberate catch-all — even a reconciled list, derived from
 * two historical lists, can't guarantee every legitimate locality is named. A
 * resident whose village isn't listed must still be able to pick something
 * and finish onboarding; it is a plain, searchable list item like any other,
 * not a separate free-text field or a second picker — it is simply kept last
 * rather than sorted alphabetically, so it always reads as the deliberate
 * fallback it is, not just another place name.
 */
export const SHETLAND_AREAS = [
  'Aith', 'Bigton', 'Bixter', 'Boddam', 'Brae', 'Bressay', 'Burra',
  'Cunningsburgh', 'Fair Isle', 'Fetlar', 'Foula', 'Hillswick', 'Laxo',
  'Lerwick', 'Levenwick', 'Mossbank', 'Nesting', 'North Roe', 'Out Skerries',
  'Papa Stour', 'Sandness', 'Sandwick', 'Scalloway', 'Sullom', 'Sumburgh',
  'Tingwall', 'Toft', 'Trondra', 'Unst', 'Vidlin', 'Voe', 'Walls',
  'Weisdale', 'Whalsay', 'Whiteness', 'Yell',
  'Other / elsewhere in Shetland',
] as const;
