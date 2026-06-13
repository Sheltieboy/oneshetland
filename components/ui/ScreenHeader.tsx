import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  /** Custom back handler (defaults to router.back). */
  onBack?: () => void;
  /** Section accent colour for the back control + bottom border. */
  accent?: string;
  /** Render the back control as a labelled pill (chevron + icon + label). */
  backStyle?: 'chevron' | 'pill';
  /** Label shown in pill mode (e.g. the section name). */
  backLabel?: string;
  /** FontAwesome5 icon shown in the back pill. */
  backIcon?: string;
  rightElement?: React.ReactNode;
  dark?: boolean;
}

export function ScreenHeader({
  title, subtitle, showBack = true, onBack, accent,
  backStyle = 'chevron', backLabel, backIcon, rightElement, dark = false,
}: ScreenHeaderProps) {
  const router = useRouter();
  const tint = dark ? colors.white : (accent ?? colors.navy);

  const handleBack = () => {
    haptic.light();
    if (onBack) onBack();
    else if (router.canGoBack()) router.back();
  };

  const Back = () => {
    if (!showBack) return <View style={styles.side} />;
    if (backStyle === 'pill') {
      return (
        <Pressable onPress={handleBack} hitSlop={12} style={[styles.pill, { backgroundColor: tint + '14' }]}>
          <FontAwesome5 name="chevron-left" size={15} color={tint} />
          {backIcon ? <FontAwesome5 name={backIcon as any} size={12} color={tint} solid /> : null}
          <Text style={[styles.pillText, { color: tint }]}>{backLabel ?? 'Back'}</Text>
        </Pressable>
      );
    }
    return (
      <Pressable onPress={handleBack} hitSlop={14} style={[styles.side, styles.chevronBtn]}>
        <FontAwesome5 name="chevron-left" size={18} color={tint} />
      </Pressable>
    );
  };

  return (
    <View style={[
      styles.header,
      dark && styles.headerDark,
      { borderBottomColor: accent ?? (dark ? colors.darkBorder : colors.border), borderBottomWidth: accent ? 2 : 1 },
    ]}>
      <Back />
      <View style={styles.titleBlock}>
        <Text style={[styles.title, dark && styles.textDark]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[styles.subtitle, dark && styles.subtitleDark]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, styles.sideRight]}>{rightElement ?? null}</View>
    </View>
  );
}

const SIDE = 76;

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.white,
  },
  headerDark: { backgroundColor: colors.navy },
  side: { width: SIDE, justifyContent: 'center' },
  sideRight: { alignItems: 'flex-end' },
  chevronBtn: { paddingVertical: 6 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: fontSize.sm, fontWeight: '800' },
  titleBlock: { flex: 1, alignItems: 'center' },
  title: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.2 },
  subtitle: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  textDark: { color: colors.white },
  subtitleDark: { color: 'rgba(255,255,255,0.6)' },
});
