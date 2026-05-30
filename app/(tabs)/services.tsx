import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { TabScreenHeader } from '@/components/TabScreenHeader';

const S = SECTIONS.services;

export default function ServicesTab() {
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TabScreenHeader section={S} />
      <View style={styles.body}>
        <View style={[styles.comingSoonIcon, { backgroundColor: S.light }]}>
          <FontAwesome5 name={S.icon as any} size={32} color={S.color} />
        </View>
        <Text style={styles.comingSoonTitle}>Coming soon</Text>
        <Text style={styles.comingSoonText}>
          The Shetland business and services directory is on its way.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12, backgroundColor: colors.screenBackground },
  comingSoonIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  comingSoonTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  comingSoonText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
