-- ============================================================================
-- memories-media: allow audio/x-m4a alongside audio/m4a
--
-- WHAT WAS WRONG
--
-- A real iPhone voice-note save (build 143) failed with 400/InvalidMimeType,
-- "mime type audio/x-m4a is not supported" — even though the app's own JS
-- explicitly sets the recording's Content-Type to 'audio/m4a' (already in
-- this bucket's allowlist) and a live server-side probe proved Storage
-- accepts 'audio/m4a' exactly as declared. Something in React Native's iOS
-- multipart/FormData bridge is substituting 'audio/x-m4a' before the bytes
-- reach Storage — a known category of platform MIME-derivation quirk, not
-- something this app's JS can be proven to fully control from here.
--
-- audio/x-m4a is a long-standing, widely-recognised unofficial alias for
-- exactly the same format audio/m4a already names (AAC audio in an MPEG-4
-- container) — it is not a different codec, and Apple's own platform
-- frameworks are a well-documented source of exactly this "x-" prefixed
-- form. This migration is the belt-and-braces half of the fix: paired with
-- client-side canonicalisation in lib/memories-api.ts (which normalises the
-- value this app's own code controls), this closes the gap regardless of
-- exactly which layer — this app's JS, or iOS's native networking bridge
-- underneath it — is responsible for the substitution actually observed on
-- a real device.
--
-- This is a single, specific, well-understood addition for a format already
-- explicitly allowed under its other name — not a broadening of what kinds
-- of files this bucket accepts.
-- ============================================================================

update storage.buckets
set allowed_mime_types = array(
  select distinct unnest(allowed_mime_types || array['audio/x-m4a'])
)
where id = 'memories-media'
  and not ('audio/x-m4a' = any(allowed_mime_types));
