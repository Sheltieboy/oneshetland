/**
 * DIAGNOSTIC BUILD — static screen only, no Supabase/Stripe/Notifications.
 * Restore from index.tsx.bak once confirmed.
 */
import { View, Text, StyleSheet } from 'react-native';

export default function DiagnosticScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>OneShetland Fetch</Text>
      <Text style={styles.sub}>✓ App launched successfully on iOS 26</Text>
      <Text style={styles.note}>Diagnostic build — no network calls</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#032F4C',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 16,
    textAlign: 'center',
  },
  sub: {
    color: '#12B3D6',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  note: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    textAlign: 'center',
  },
});
