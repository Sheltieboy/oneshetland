import { useEffect, Component, ReactNode } from 'react';
import { View, ActivityIndicator, Text, ScrollView } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '@stripe/stripe-react-native';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/theme';

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

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inCustomerGroup = segments[0] === '(customer)';
    const inDriverGroup = segments[0] === '(driver)';
    const inAdminGroup = segments[0] === '(admin)';
    const inProtected = inCustomerGroup || inDriverGroup || inAdminGroup;

    if (!session) {
      // Not signed in — redirect away from protected routes to the landing page
      if (inProtected) {
        router.replace('/');
      }
      return;
    }

    // Signed in — redirect away from auth/landing to the right dashboard
    if (inAuthGroup || (segments as string[])[0] === 'index' || segments.length === 0) {
      // Use profile role if available, default to customer
      const role = profile?.role ?? 'customer';
      if (role === 'admin' || role === 'moderator') {
        router.replace('/(admin)/dashboard');
      } else if (role === 'driver') {
        router.replace('/(driver)/dashboard');
      } else {
        // customer, business_owner, employer, contributor all land on customer dashboard
        // within the Delivers app context
        router.replace('/(customer)/dashboard');
      }
      return;
    }

    if (!profile) return;

    // Pure customers can't access driver routes
    if (inDriverGroup && profile.role === 'customer') {
      router.replace('/(customer)/dashboard');
    }
  }, [session, profile, loading, segments]);

  // Show a navy loading screen while auth state is being determined
  // This prevents a flash of the landing page for signed-in users
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.navy, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(customer)" />
      <Stack.Screen name="(driver)" />
      <Stack.Screen name="(admin)" />
      <Stack.Screen name="account" />
    </Stack>
  );
}

export default function RootLayout() {
  const content = (
    <AuthProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </AuthProvider>
  );

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        {STRIPE_KEY ? (
          <StripeProvider
            publishableKey={STRIPE_KEY}
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
