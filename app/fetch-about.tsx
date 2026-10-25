// Fetch v1 screen, retired by Fetch v2 (Step 12). This address only forwards: to /(tabs)/fetch.
// The old source is kept for reference in legacy/fetch-v1/ (not routed, not bundled). It priced on the phone (95p/mile),
// wrote delivery_requests/runs directly and called notify-drivers — none of which Fetch v2 allows.
import { Redirect } from 'expo-router';

export default function RetiredFetchV1About() {
  return <Redirect href="/(tabs)/fetch" />;
}
