import 'react-native-gesture-handler';   // must be first import in the entry file
import { useEffect, useState, useRef, Component, ReactNode } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Stack, useRouter, useSegments, useGlobalSearchParams, useRootNavigationState, usePathname } from 'expo-router';
import { sanitizeNext } from '@/lib/auth-redirect';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '@stripe/stripe-react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { initAnalytics, identifyAnalytics, track } from '@/lib/analytics';
import { registerPushToken, notificationRoute } from '@/lib/notifications';
import { SCREEN_PUSH, MODAL_PRESENT, SECTION_ROOT } from '@/constants/nav';
import { SplashAnimation } from '@/components/SplashAnimation';
import { BrandedAlertProvider } from '@/components/BrandedAlert';
import { INTRO_SEEN_KEY } from './intro';

// Temporary error boundary — catches JS crashes and shows the error
// so we can diagnose the TestFlight crash. Remove once stable.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      const err = this.state.error as Error;
      return (
        <ScrollView style={{ flex: 1, backgroundColor: '#1a1a2e', padding: 20, paddingTop: 60 }}>
          <Text style={{ color: '#ff6b6b', fontSize: 18, fontWeight: 'bold', marginBottom: 10 }}>
            ⚠️ App Error (debug build)
          </Text>
          <Text style={{ color: '#fff', fontSize: 13, marginBottom: 10 }}>{err.message}</Text>
          <Text style={{ color: '#aaa', fontSize: 11, fontFamily: 'monospace' }}>{err.stack}</Text>
        </ScrollView>
      );
    }
    return this.props.children;
  }
}

const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

function RootNavigator() {
  const { session, profile, loading, hasAppliedToDrive } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const navParams = useGlobalSearchParams<{ next?: string }>();
  const pathname = usePathname();

  // ── Analytics: init once, identify on auth change, autocapture screen views ──
  useEffect(() => { void initAnalytics(); }, []);
  useEffect(() => {
    const role = (profile as any)?.role;
    identifyAnalytics(!session ? 'visitor' : role === 'admin' ? 'admin' : 'user');
  }, [session, profile]);
  useEffect(() => {
    if (pathname) track('screen_viewed', { props: { route: pathname } });
  }, [pathname]);

  // Track whether the app was cold-launched via a deep link (universal link or
  // custom scheme). If so, we must NOT auto-redirect signed-in users to /(tabs)
  // before expo-router has a chance to route them to the deep-link target.
  const launchedViaDeepLink = useRef(false);
  const [linkCheckDone, setLinkCheckDone] = useState(false);

  // Splash is rendered as an overlay on top of the real content; it cross-fades
  // out when both (a) auth has resolved and (b) its own entrance + hold finished.
  const [splashGone, setSplashGone] = useState(false);

  // First-launch intro tour gate. We track whether the AsyncStorage check has
  // completed (introCheckDone) and what it found (introSeen). Until the check
  // resolves we treat the user as if they HAVE seen it, to avoid flashing the
  // tour past returning users while the lookup is in flight.
  const [introCheckDone, setIntroCheckDone] = useState(false);
  const [introSeen,      setIntroSeen]      = useState(true);

  useEffect(() => {
    Linking.getInitialURL().then(url => {
      if (url) {
        // Heuristic: any URL that isn't the bare scheme is a deep link target
        const u = new URL(url);
        const path = u.pathname;
        if (path && path !== '/' && path !== '') launchedViaDeepLink.current = true;
      }
      setLinkCheckDone(true);
    }).catch(() => setLinkCheckDone(true));
  }, []);

  // Check whether the user has seen the first-launch intro tour.
  useEffect(() => {
    AsyncStorage.getItem(INTRO_SEEN_KEY)
      .then(v => setIntroSeen(v === '1'))
      .catch(() => setIntroSeen(true))   // fail closed — never re-show on storage error
      .finally(() => setIntroCheckDone(true));
  }, []);

  // Register for push notifications once the user is fully loaded
  useEffect(() => {
    if (session?.user?.id && profile) {
      registerPushToken(session.user.id).catch(() => {});
    }
  }, [session?.user?.id, profile]);

  // Route the user when they TAP a notification. Without this every tap just
  // opens the app on Home and the carefully-attached routing data is wasted.
  //
  // We capture the target route into state and only navigate once the root
  // navigator is actually mounted (rootNavState.key) and auth has resolved.
  // Navigating earlier — which happens on a COLD start, where the listener
  // fires before the <Stack> mounts — silently no-ops. That was the bug.
  const coldNotifHandled = useRef(false);
  const [pendingNotifRoute, setPendingNotifRoute] = useState<string | null>(null);
  const rootNavState = useRootNavigationState();
  const navReady = !!rootNavState?.key;

  // Warm taps (app already running/backgrounded).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(resp => {
      const route = notificationRoute(resp.notification.request.content.data as Record<string, unknown>);
      if (route) setPendingNotifRoute(route);
    });
    return () => sub.remove();
  }, []);

  // Cold start: app launched by tapping a notification.
  useEffect(() => {
    if (coldNotifHandled.current) return;
    coldNotifHandled.current = true;
    Notifications.getLastNotificationResponseAsync().then(resp => {
      if (!resp) return;
      const route = notificationRoute(resp.notification.request.content.data as Record<string, unknown>);
      if (route) setPendingNotifRoute(route);
      // Clear it so opening the app normally later doesn't re-route to the same
      // screen (this response persists across launches otherwise).
      (Notifications as { clearLastNotificationResponseAsync?: () => Promise<void> })
        .clearLastNotificationResponseAsync?.();
    }).catch(() => {});
  }, []);

  // Navigate once the navigator is mounted and auth has settled.
  useEffect(() => {
    if (!pendingNotifRoute || !navReady || loading) return;
    const target = pendingNotifRoute;
    setPendingNotifRoute(null);
    try { router.push(target as never); } catch { /* invalid route — ignore */ }
  }, [pendingNotifRoute, navReady, loading]);

  // Separate effect for the intro gate. Reads AsyncStorage fresh on every
  // segments-change so the moment intro.tsx writes the flag and replaces to
  // (tabs), the next gate evaluation sees the updated value and does NOT
  // redirect back — avoiding a loop.
  useEffect(() => {
    if (!linkCheckDone) return;
    if (launchedViaDeepLink.current) return;
    if ((segments as string[])[0] === 'intro') return;
    AsyncStorage.getItem(INTRO_SEEN_KEY).then(v => {
      if (v !== '1') router.replace('/intro');
    }).catch(() => { /* fail open — assume seen */ });
  }, [segments, linkCheckDone]);

  useEffect(() => {
    if (loading) return;
    if (!linkCheckDone) return;
    if (!introCheckDone) return;

    // Don't run sign-in routing while the user is in the intro flow — let the
    // intro finish handler own the navigation. Otherwise this effect could
    // race the intro's router.replace.
    if ((segments as string[])[0] === 'intro') return;

    const inAuthGroup     = segments[0] === '(auth)';
    const inCustomerGroup = segments[0] === '(customer)';
    const inDriverGroup   = segments[0] === '(driver)';
    const inAdminGroup    = segments[0] === '(admin)';
    const inAccountScreen = (segments as string[])[0] === 'account';

    // Only genuinely-private routes are protected. Tabs, Spik detail,
    // Local browsing, etc. are all open — each screen prompts for sign-in
    // when the user tries to do something that needs an account.
    const inProtected = inCustomerGroup || inDriverGroup || inAdminGroup || inAccountScreen;

    if (!session) {
      // Not signed in — bounce off the genuinely-protected routes into the open app
      if (inProtected) {
        router.replace('/(tabs)');
      }
      return;
    }

    // Signed in — redirect away from auth/landing to the tabs.
    // BUT: never auto-redirect if the app was launched via a deep link
    // (universal link / NFC tile) — otherwise we trample the link target.
    const isOnDeepLinkRoute =
      (segments as string[])[0] === 't' ||
      (segments as string[])[0] === 'nfc' ||
      (segments as string[])[0] === 'g' ||
      (segments as string[])[0] === 'driver';

    if (!launchedViaDeepLink.current && !isOnDeepLinkRoute) {
      if (inAuthGroup || (segments as string[])[0] === 'index' || (segments as string[]).length === 0) {
        // Honour a `next` (return-to) param if a gated action/guard sent the
        // user to sign-in — land them back where they were, not on Home.
        const dest = (inAuthGroup ? sanitizeNext(navParams?.next) : null) ?? '/(tabs)';
        router.replace(dest as never);
        return;
      }
    }

    if (!profile) return;

    // Driver routes are a capability gated by driver_profiles.driver_status, not
    // by role. Users who haven't applied to drive (and aren't admin) are sent
    // back to the tabs. (The (driver) layout enforces the same rule.)
    const canAccessDriver = hasAppliedToDrive || profile.role === 'admin';
    if (inDriverGroup && !canAccessDriver) {
      router.replace('/(tabs)');
    }
  }, [session, profile, hasAppliedToDrive, loading, segments, linkCheckDone, introCheckDone, introSeen, navParams?.next]);

  // The Stack renders behind the splash overlay so we get a true cross-fade
  // when the splash dissolves at the end of its animation.
  return (
    <>
      {!loading && (
        <Stack screenOptions={{ headerShown: false, ...SCREEN_PUSH }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="intro" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="auth/confirm" />
          <Stack.Screen name="(customer)" />
          <Stack.Screen name="(driver)" />
          <Stack.Screen name="(admin)" />
          <Stack.Screen name="account" />
          <Stack.Screen name="blocked-users" />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="home" />
          <Stack.Screen name="search" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="(tabs)" options={{ ...SECTION_ROOT }} />
          <Stack.Screen name="spik-detail" />
          <Stack.Screen name="spik-suggest" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="spik-add" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="spik-add-variation" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="boat-add" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="spik-filter" />
          <Stack.Screen name="shift-detail" />
          <Stack.Screen name="shift-post" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="employer-profile" />
          <Stack.Screen name="my-posted-shifts" />
          <Stack.Screen name="my-shift-applications" />
          <Stack.Screen name="my-work" />
          <Stack.Screen name="edit-profile" />
          <Stack.Screen name="security" />
          <Stack.Screen name="local-businesses-browse" />
          <Stack.Screen name="local-combined-feed" />
          <Stack.Screen name="local-business-detail" />
          <Stack.Screen name="local-business-register" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="business-claim" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="hubs/index" options={{ ...SECTION_ROOT }} />
          <Stack.Screen name="hubs/[id]" />
          <Stack.Screen name="hub-register" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="hub-admin" />
          <Stack.Screen name="hub-members" />
          <Stack.Screen name="hub-notices-manage" />
          <Stack.Screen name="hub-membership-types" />
          <Stack.Screen name="hub-my-memberships" />
          <Stack.Screen name="hub-directory" />
          <Stack.Screen name="hub-documents" />
          <Stack.Screen name="hub-broadcast" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="hub-campaigns" />
          <Stack.Screen name="hub-campaign" />
          <Stack.Screen name="hub-events" />
          <Stack.Screen name="job/[id]" />
          <Stack.Screen name="job-post" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="job-applicants" />
          <Stack.Screen name="business-jobs" />
          <Stack.Screen name="my-posted-jobs" />
          <Stack.Screen name="my-job-applications" />
          <Stack.Screen name="saved-jobs" />
          <Stack.Screen name="work-profile" />
          <Stack.Screen name="hub-donate" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="give/[id]" />
          <Stack.Screen name="notices" />
          <Stack.Screen name="memory-new" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="hub-notice-compose" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="local-business-dashboard" />
          <Stack.Screen name="local-my-cards" />
          <Stack.Screen name="local-my-passes" />
          <Stack.Screen name="local-my-gifts" />
          <Stack.Screen name="local-stamp-scanner" />
          <Stack.Screen name="local-redeem" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="local-verify" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="local-offers" />
          <Stack.Screen name="local-loyalty-hub" />
          <Stack.Screen name="referrals" />
          <Stack.Screen name="local-bookable-browse" />
          <Stack.Screen name="local-offer-new" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="local-wallet" />
          <Stack.Screen name="local-pay" />
          <Stack.Screen name="nfc/[token]" />
          <Stack.Screen name="t/[token]" />
          <Stack.Screen name="g/[code]" />
          <Stack.Screen name="b/[slug]" />
          <Stack.Screen name="events/[id]" />
          <Stack.Screen name="event-create" options={{ ...MODAL_PRESENT }} />
          <Stack.Screen name="event-manage" />
          <Stack.Screen name="event-scanner" />
          <Stack.Screen
            name="event-ticket-checkout"
            options={{
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              sheetCornerRadius: 28,
              sheetAllowedDetents: [0.7, 1],
              animation: 'slide_from_bottom',
            }}
          />
          <Stack.Screen name="my-event-tickets" />
          <Stack.Screen name="my-event-ticket" />
          <Stack.Screen name="driver/connect-return" />
          <Stack.Screen name="games/index" options={{ ...SECTION_ROOT }} />
          <Stack.Screen name="games/spik-sprint" />
          <Stack.Screen name="games/spik-snap" />
          <Stack.Screen name="games/guess-da-wird" />
          <Stack.Screen name="games/map-it" />
          <Stack.Screen name="games/stats" />
          <Stack.Screen name="fetch-about" />
          <Stack.Screen name="fetch-about-driver" />
          <Stack.Screen name="payment-setup" />
          <Stack.Screen name="local-book-units" />
          <Stack.Screen name="local-buy-unit" />
          <Stack.Screen name="local-gift" />
          <Stack.Screen name="(admin)/email-centre" />
          <Stack.Screen name="(admin)/compliance" />
          <Stack.Screen name="(admin)/event-approvals" />
        </Stack>
      )}

      {!splashGone && (
        <SplashAnimation
          ready={!loading && linkCheckDone && introCheckDone}
          onDone={() => setSplashGone(true)}
        />
      )}
    </>
  );
}

export default function RootLayout() {
  const content = (
    <AuthProvider>
      <BrandedAlertProvider>
        <StatusBar style="light" />
        <RootNavigator />
      </BrandedAlertProvider>
    </AuthProvider>
  );

  return (
    <ErrorBoundary>
      {/* GestureHandlerRootView is required by react-native-gesture-handler v2
          for any pinch/pan gestures to work. Wraps the entire app. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          {STRIPE_KEY ? (
            <StripeProvider
              publishableKey={STRIPE_KEY}
              merchantIdentifier="merchant.com.oneshetland.app"
            >
              {content}
            </StripeProvider>
          ) : (
            content
          )}
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
