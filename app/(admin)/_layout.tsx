import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';

export default function AdminLayout() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.navy} />
      </View>
    );
  }

  if (!session) return <Redirect href="/(auth)/sign-in" />;
  if (profile && profile.role !== 'admin') return <Redirect href="/(customer)/dashboard" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="dashboard" />
      <Stack.Screen name="driver-approvals" />
      <Stack.Screen name="delivery-requests" />
      <Stack.Screen name="runs" />
    </Stack>
  );
}
