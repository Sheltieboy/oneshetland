import { Stack } from 'expo-router';
import { RequestProvider } from '@/context/RequestContext';

export default function RequestLayout() {
  return (
    <RequestProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="step-1" />
        <Stack.Screen name="step-2" />
        <Stack.Screen name="step-3" />
        <Stack.Screen name="step-4" />
      </Stack>
    </RequestProvider>
  );
}
