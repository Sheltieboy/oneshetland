import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import { colors, spacing, radius } from '@/constants/theme';

interface LoadingStateProps {
  type?: 'spinner' | 'skeleton-list' | 'skeleton-card';
  /** Spinner colour (e.g. the section colour). */
  accent?: string;
  /** Number of skeleton rows/cards. */
  count?: number;
}

/** Canonical loading affordance — a centred spinner, or content skeletons. */
export function LoadingState({ type = 'spinner', accent = colors.accent, count = 5 }: LoadingStateProps) {
  if (type === 'spinner') {
    return <View style={styles.center}><ActivityIndicator color={accent} /></View>;
  }
  const card = type === 'skeleton-card';
  return (
    <View style={styles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={styles.row}>
          <Pulse style={styles.avatar} />
          <View style={{ flex: 1, gap: 8 }}>
            <Pulse style={[styles.line, { width: '60%' }]} />
            <Pulse style={[styles.line, { width: '90%' }]} />
            {card ? <Pulse style={[styles.line, { width: '40%' }]} /> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Pulse({ style }: { style?: any }) {
  const o = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(o, { toValue: 0.4, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.View style={[styles.skeleton, style, { opacity: o }]} />;
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing.xxl, alignItems: 'center', justifyContent: 'center' },
  list: { padding: spacing.md, gap: spacing.md },
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  skeleton: { backgroundColor: colors.border, borderRadius: radius.sm },
  avatar: { width: 48, height: 48, borderRadius: radius.md },
  line: { height: 12, borderRadius: radius.xs },
});
