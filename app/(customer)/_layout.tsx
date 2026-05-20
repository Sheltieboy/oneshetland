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
  if (profile && (profile.role === 'admin' || profile.role === 'moderator')) {
    return <Redirect href="/(admin)/dashboard" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="dashboard" />
      <Stack.Screen name="request" />
      <Stack.Screen name="apply-driver" />
      <Stack.Screen name="request-detail" />
      <Stack.Screen name="previous-requests" />
      <Stack.Screen name="saved-addresses" />
      <Stack.Screen name="payment-setup" />
    </Stack>
  );
}
