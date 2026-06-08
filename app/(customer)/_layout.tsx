import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';

export default function CustomerLayout() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.navy} />
      </View>
    );
  }

  if (!session) return <Redirect href="/(auth)/sign-in" />;
  // Admins/moderators can use the customer Fetch flow too — the admin
  // dashboard is reachable from Me → Admin, not by hijacking other tabs.

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="dashboard" />
      <Stack.Screen name="request" />
      <Stack.Screen name="apply-driver" />
      <Stack.Screen name="request-detail" />
      <Stack.Screen name="previous-requests" />
      <Stack.Screen name="saved-addresses" />
    </Stack>
  );
}
