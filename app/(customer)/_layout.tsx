import { Redirect, Stack, usePathname } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';
import { AppBottomNav } from '@/components/AppBottomNav';

export default function CustomerLayout() {
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
  // Admins/moderators can use the customer Fetch flow too — the admin
  // dashboard is reachable from Me → Admin, not by hijacking other tabs.

  // Render the shared bottom nav beneath the stack so Fetch sub-screens keep the
  // main navigation (they live outside the (tabs) group, which is why the tab bar
  // used to vanish here). The stack fills the space ABOVE the bar — nothing is
  // covered — and AppBottomNav handles phone (bottom bar) vs tablet (NavRail).
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="dashboard" />
          <Stack.Screen name="request" />
          <Stack.Screen name="apply-driver" />
          <Stack.Screen name="request-detail" />
          <Stack.Screen name="previous-requests" />
          <Stack.Screen name="saved-addresses" />
        </Stack>
      </View>
      <AppBottomNav />
    </View>
  );
}
