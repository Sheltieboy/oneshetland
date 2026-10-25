import { Redirect, Stack, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import { v1Forward } from '@/lib/fetch/mobile';
import { useAuth } from '@/context/AuthContext';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';
import { AppBottomNav } from '@/components/AppBottomNav';

export default function DriverLayout() {
  const { session, profile, loading, hasAppliedToDrive } = useAuth();
  const pathname = usePathname();
  const segments = useSegments();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  // Fetch v2 (Step 12): the old v1 screens here forward to their v2 replacements; only payouts (connect-bank) stays.
  const forward = v1Forward('(driver)', (segments as string[])[1], typeof id === 'string' ? id : null);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.navy} />
      </View>
    );
  }

  if (!session) return <Redirect href={`/(auth)/sign-in?next=${encodeURIComponent(pathname)}`} />;
  if (forward) return <Redirect href={forward as never} />;
  // The Driver area is a capability, gated by driver_profiles.driver_status —
  // NOT by profiles.role. Anyone who has applied (pending/approved/…) can see it
  // (to view their status); admins can use it too. Everyone else is sent to the
  // Fetch section, where they can apply via the Driver toggle.
  const canAccessDriver = hasAppliedToDrive || profile?.role === 'admin';
  if (profile && !canAccessDriver) return <Redirect href="/(tabs)/fetch" />;

  // Keep the main navigation beneath the driver stack (same reason as the
  // customer layout) — the stack fills the space above the bar.
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="dashboard" />
          <Stack.Screen name="create-run" />
          <Stack.Screen name="request-detail" />
          <Stack.Screen name="connect-bank" />
        </Stack>
      </View>
      <AppBottomNav />
    </View>
  );
}
