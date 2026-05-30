import { useEffect, useState, useRef, Component, ReactNode } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '@stripe/stripe-react-native';
import * as Linking from 'expo-linking';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { registerPushToken } from '@/lib/notifications';
import { SplashAnimation } from '@/components/SplashAnimation';
import { BrandedAlertProvider } from '@/components/BrandedAlert';

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
  const { session, profile, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Track whether the app was cold-launched via a deep link (universal link or
  // custom scheme). If so, we must NOT auto-redirect signed-in users to /(tabs)
  // before expo-router has a chance to route them to the deep-link target.
  const launchedViaDeepLink = useRef(false);
  const [linkCheckDone, setLinkCheckDone] = useState(false);

  // Splash is rendered as an overlay on top of the real content; it cross-fades
  // out when both (a) auth has resolved and (b) its own entrance + hold finished.
  const [splashGone, setSplashGone] = useState(false);

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

  // Register for push notifications once the user is fully loaded
  useEffect(() => {
    if (session?.user?.id && profile) {
      registerPushToken(session.user.id).catch(() => {});
    }
  }, [session?.user?.id, profile]);

  useEffect(() => {
    if (loading) return;
    if (!linkCheckDone) return;

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
      (segments as string[])[0] === 'nfc';

    if (!launchedViaDeepLink.current && !isOnDeepLinkRoute) {
      if (inAuthGroup || (segments as string[])[0] === 'index' || segments.length === 0) {
        router.replace('/(tabs)');
        return;
      }
    }

    if (!profile) return;

    // Pure customers can't access driver routes — send back to tabs
    if (inDriverGroup && profile.role === 'customer') {
      router.replace('/(tabs)');
    }
  }, [session, profile, loading, segments, linkCheckDone]);

  // The Stack renders behind the splash overlay so we get a true cross-fade
  // when the splash dissolves at the end of its animation.
  return (
    <>
      {!loading && (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(customer)" />
          <Stack.Screen name="(driver)" />
          <Stack.Screen name="(admin)" />
          <Stack.Screen name="account" />
          <Stack.Screen name="home" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="spik-detail" />
          <Stack.Screen name="spik-suggest" />
          <Stack.Screen name="spik-filter" />
          <Stack.Screen name="shift-detail" />
          <Stack.Screen name="shifts-browse" />
          <Stack.Screen name="employer-applications" />
          <Stack.Screen name="employer-profile" />
          <Stack.Screen name="my-posted-shifts" />
          <Stack.Screen name="my-shift-applications" />
          <Stack.Screen name="shift-worker-profile" />
          <Stack.Screen name="edit-profile" />
          <Stack.Screen name="local-businesses-browse" />
          <Stack.Screen name="local-business-detail" />
          <Stack.Screen name="local-business-register" />
          <Stack.Screen name="local-business-dashboard" />
          <Stack.Screen name="local-my-cards" />
          <Stack.Screen name="local-stamp-scanner" />
          <Stack.Screen name="local-offers" />
          <Stack.Screen name="local-offer-new" />
          <Stack.Screen name="local-wallet" />
          <Stack.Screen name="local-pay" />
          <Stack.Screen name="nfc/[token]" />
          <Stack.Screen name="t/[token]" />
          <Stack.Screen name="games/index" />
          <Stack.Screen name="games/spik-sprint" />
          <Stack.Screen name="games/spik-snap" />
          <Stack.Screen name="games/stats" />
          <Stack.Screen name="fetch-about" />
          <Stack.Screen name="fetch-about-driver" />
        </Stack>
      )}

      {!splashGone && (
        <SplashAnimation
          ready={!loading && linkCheckDone}
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
    </ErrorBoundary>
  );
}
