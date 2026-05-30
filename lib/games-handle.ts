/**
 * games-handle.ts
 * Client-side validation and availability check for the Games Centre handle.
 *
 * Philosophy: don't be a killjoy. Daft / silly / cheeky names are fine — that's
 * half the fun. We block clear hate, explicit sexual content, and impersonation
 * of platform staff. Mild swears slip through; that's the point.
 */

import { supabase } from './supabase';

export type HandleValidation =
  | { ok: true }
  | { ok: false; reason: HandleReason; message: string };

export type HandleReason =
  | 'too_short'
  | 'too_long'
  | 'invalid_chars'
  | 'reserved'
  | 'blocked';

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const HANDLE_REGEX = /^[A-Za-z0-9_-]+$/;

// ── Reserved (impersonation prevention) ──────────────────────────────────────
// Substring match after lowercasing. Things like "admin69" or "OneShetlandMod"
// still trip this — that's intentional.
const RESERVED = [
  'admin', 'moderator', 'mod', 'official', 'system', 'support',
  'oneshetland', 'one-shetland', 'staff', 'helpdesk', 'root',
];

// ── Blocked content ──────────────────────────────────────────────────────────
// Deliberately short. Targets hate speech, the worst slurs, and explicit sexual
// content — NOT mild swearing. Leetspeak is normalised before matching so
// "n1gg3r" and "ni99er" both trip the n-word check. The list is intentionally
// not exhaustive; flagrant misses can be added quietly.
//
// We match these as substrings of the normalised handle, so "PassNigger" trips
// but "Bigger" does not (no n-i-g-g-e-r substring in "bigger" once leet-stripped).
const BLOCKED_SUBSTRINGS = [
  // Racial slurs
  'nigger', 'nigga', 'chink', 'spic', 'kike', 'gook', 'wetback', 'coon',
  // Homophobic / transphobic slurs
  'faggot', 'tranny', 'shemale', 'dyke',
  // Ableist slurs
  'retard',
  // Nazi / hate
  'hitler', 'nazi', 'heil',
  // Explicit sexual content (the worst — mild stuff is fine)
  'rape', 'pedo', 'paedo', 'incest', 'cunt',
  // Self-harm encouragement
  'kys', 'killyourself',
];

// Word-boundary blocks (don't catch substrings). For words where partial matches
// are common in innocent words.
const BLOCKED_EXACT = new Set([
  'shit', // exact only — "shitake", "shittland" remain allowed
]);

// ── Normalisation: strip leetspeak before checking ───────────────────────────
function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[8]/g, 'b')
    .replace(/[9]/g, 'g')
    .replace(/[_\-\s]/g, '');
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateHandle(raw: string): HandleValidation {
  const trimmed = raw.trim();

  if (trimmed.length < HANDLE_MIN) {
    return { ok: false, reason: 'too_short', message: `Handles need at least ${HANDLE_MIN} characters.` };
  }
  if (trimmed.length > HANDLE_MAX) {
    return { ok: false, reason: 'too_long', message: `Handles can be up to ${HANDLE_MAX} characters.` };
  }
  if (!HANDLE_REGEX.test(trimmed)) {
    return { ok: false, reason: 'invalid_chars', message: 'Letters, numbers, dashes and underscores only — no spaces.' };
  }

  const lower = trimmed.toLowerCase();
  if (RESERVED.some(r => lower.includes(r))) {
    return { ok: false, reason: 'reserved', message: 'That handle looks like staff or platform — pick something else.' };
  }

  const normalised = normalise(trimmed);
  if (BLOCKED_SUBSTRINGS.some(b => normalised.includes(b))) {
    return { ok: false, reason: 'blocked', message: 'That handle contains words we don\'t allow. Try something else.' };
  }
  if (BLOCKED_EXACT.has(normalised)) {
    return { ok: false, reason: 'blocked', message: 'That handle contains words we don\'t allow. Try something else.' };
  }

  return { ok: true };
}

// ── Availability check ──────────────────────────────────────────────────────
// Returns true if free, false if taken. `excludeUserId` skips the user's own
// row so re-saving the same handle isn't treated as a clash.

export async function isHandleAvailable(
  handle: string,
  excludeUserId: string,
): Promise<boolean> {
  const trimmed = handle.trim();
  if (!trimmed) return true;

  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .ilike('games_handle', trimmed)
    .neq('id', excludeUserId)
    .limit(1);

  if (error) {
    // Network blip — let the save attempt surface the real error.
    console.warn('[games-handle] availability check failed:', error.message);
    return true;
  }
  return (data?.length ?? 0) === 0;
}
