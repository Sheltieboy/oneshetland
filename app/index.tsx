/**
 * app/index.tsx
 *
 * The root URL just bounces straight into the tabs. The app is open for browsing
 * to everyone — signed-in or not. Each individual screen handles its own
 * "you need an account to do this" prompts.
 */

import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/(tabs)" />;
}
