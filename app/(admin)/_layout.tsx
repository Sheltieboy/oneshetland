import { Redirect, Stack, usePathname } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';

export default function AdminLayout() {
  const { session, profile, loading } = useAuth();
  const pathname = usePathname();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.navy} />
      </View>
    );
  }

  if (!session) return <Redirect href={`/(auth)/sign-in?next=${encodeURIComponent(pathname)}`} />;
  // Bounce non-admins to the Fetch tab (home, with the bottom tab bar) rather
  // than the standalone /(customer)/dashboard route, which has no tabs.
  if (profile && profile.role !== 'admin') return <Redirect href="/(tabs)/fetch" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="dashboard" />
      <Stack.Screen name="driver-approvals" />
      <Stack.Screen name="delivery-requests" />
      <Stack.Screen name="runs" />
      <Stack.Screen name="payments" />
      <Stack.Screen name="disputes" />
      <Stack.Screen name="regions" />
      <Stack.Screen name="alert-approvals" />
      <Stack.Screen name="alerts" />
      <Stack.Screen name="business-claims" />
    </Stack>
  );
}
