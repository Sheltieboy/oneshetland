// Fetch v1 screen, retired by Fetch v2 (Step 12). This address only forwards: app/(customer)/_layout.tsx sends it to the v2 screen (lib/fetch/mobile.ts v1Forward).
// The old source is kept for reference in legacy/fetch-v1/ (not routed, not bundled). It priced on the phone (95p/mile),
// wrote delivery_requests/runs directly and called notify-drivers — none of which Fetch v2 allows.
export default function RetiredFetchV1Screen() {
  return null;
}
