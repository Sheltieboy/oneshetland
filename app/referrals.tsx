/**
 * referrals.tsx — retired. The referral reward programme is not part of the launch app, so this route no longer shows anything:
 * a direct or stale link to /referrals goes straight back to the Me screen.
 */

import { Redirect } from 'expo-router';

export default function ReferralsRetired() {
  return <Redirect href="/(tabs)/me" />;
}
