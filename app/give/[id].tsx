/**
 * give/[id].tsx
 * Deep-link target for campaign QR codes / share links
 * (https://oneshetland.com/give/<campaignId> or oneshetland-fetch://give/<id>).
 * If the app is installed the universal link lands here and we route straight
 * to the campaign page.
 */

import { Redirect, useLocalSearchParams } from 'expo-router';

export default function GiveRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return <Redirect href="/hubs" />;
  return <Redirect href={`/hub-campaign?id=${id}`} />;
}
