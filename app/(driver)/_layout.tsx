import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';

export default function DriverLayout() {
  const { session, profile, loading, hasAppliedToDrive } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.navy} />
      </View>
    );
  }

  if (!session) return <Redirect href="/(auth)/sign-in" />;
  // The Driver area is a capability, gated by driver_profiles.driver_status —
  // NOT by profiles.role. Anyone who has applied (pending/approved/…) can see it
  // (to view their status); admins can use it too. Everyone else is sent to the
  // Fetch section, where they can apply via the Driver toggle.
  const canAccessDriver = hasAppliedToDrive || profile?.role === 'admin';
  if (profile && !canAccessDriver) return <Redirect href="/(tabs)/fetch" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="dashboard" />
      <Stack.Screen name="create-run" />
      <Stack.Screen name="request-detail" />
      <Stack.Screen name="connect-bank" />
    </Stack>
  );
}
