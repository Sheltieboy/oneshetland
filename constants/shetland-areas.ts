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
 * The final entry, "Other / elsewhere in Shetland", is a deliberate
 * catch-all — even a 36-place reconciled list, derived from two historical
 * lists, can't guarantee every legitimate locality is named. A resident
 * whose village isn't listed must still be able to pick something and finish
 * onboarding; it is a plain list item like any other, not a separate free-text
 * field or a second picker.
 */
export const SHETLAND_AREAS = [
  'Lerwick', 'Scalloway', 'Brae', 'Aith', 'Walls', 'Sandness', 'Sandwick',
  'Levenwick', 'Bigton', 'Boddam', 'Sumburgh', 'Cunningsburgh', 'Bixter',
  'Whiteness', 'Weisdale', 'Tingwall', 'Nesting', 'Vidlin', 'Laxo', 'Voe',
  'Mossbank', 'Sullom', 'Toft', 'Hillswick', 'North Roe',
  'Yell', 'Unst', 'Fetlar', 'Whalsay', 'Out Skerries',
  'Bressay', 'Burra', 'Trondra',
  'Foula', 'Fair Isle', 'Papa Stour',
  'Other / elsewhere in Shetland',
] as const;
