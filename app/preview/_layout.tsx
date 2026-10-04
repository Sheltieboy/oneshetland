/**
 * Preview shell — DESIGN PREVIEW ONLY. Not linked from the app, development builds only (it redirects away in a
 * release build).
 *
 * Purpose: show Home V2 / Local V2 exactly where they would sit in the app — inside a bottom-tab navigator, with the
 * app's REAL AppTabBar (same component, same NAV model, same safe-area handling) and tab-scene sizing, so the
 * available viewport height is the true one. Nothing in (tabs) is replaced or edited.
 *
 * How: a two-screen Tabs navigator (home-v2, local-v2) whose tabBar hands the real AppTabBar a state in which those
 * screens are named for the tabs they stand in for ('index' = Home, 'local' = Local), so Home / Local light up
 * correctly. Tapping Home or Local stays inside the preview (carrying the state / viewer); every other destination
 * (What's On, Work, Directory, More…) opens the real production screen, as it would in the app.
 */
import React from 'react';
import { Redirect, Tabs, useGlobalSearchParams, useRouter } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { AppTabBar } from '@/components/AppTabBar';
import { SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';

const STANDS_IN: Record<string, string> = { 'home-v2': 'index', 'local-v2': 'local' };

function ShellTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const router = useRouter();
  const q = useGlobalSearchParams<{ state?: string; as?: string; work?: string }>();
  const params = { state: q.state ?? 'seed', as: q.as ?? 'public', ...(q.work ? { work: q.work } : {}) };
  const shellState = { ...state, routes: state.routes.map((r) => ({ ...r, name: STANDS_IN[r.name] ?? r.name })) };
  const shellNav = {
    ...navigation,
    navigate: (name: string) => {
      if (name === 'index') router.replace({ pathname: '/preview/home-v2' as never, params });
      else if (name === 'local') router.replace({ pathname: '/preview/local-v2' as never, params });
      else router.navigate(`/(tabs)/${name}` as never);
    },
  } as unknown as BottomTabBarProps['navigation'];
  return <AppTabBar state={shellState as BottomTabBarProps['state']} descriptors={descriptors} navigation={shellNav} insets={insets} />;
}

export default function PreviewShell() {
  const { isTablet } = useAppLayout();
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Tabs
      tabBar={(props) => <ShellTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 } }}
    >
      <Tabs.Screen name="home-v2" />
      <Tabs.Screen name="local-v2" />
    </Tabs>
  );
}
