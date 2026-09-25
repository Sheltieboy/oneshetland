import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing, StyleSheet, Dimensions, AccessibilityInfo } from 'react-native';
import { colors } from '@/constants/theme';
import { haptic } from '@/lib/haptics';
import { CELEBRATION_MS } from '@/lib/ticket-celebration';

const { width, height } = Dimensions.get('window');
const EMOJI = ['🎉', '✨', '🎊', '⭐️'];
const PIECES = 10;

/**
 * A small "you're in!" reward when the holder's ticket is checked in (valid → used).
 *
 * Deliberately light: a spring-in check card and a short fall of emoji, gone in
 * under two seconds, on an overlay that never takes a touch — the ticket beneath
 * stays usable throughout. With "reduce motion" on, the card appears without
 * the falling pieces. Animated API only; no extra dependencies.
 */
export function TicketCelebration({ visible, onDone }: { visible: boolean; onDone: () => void }) {
  const scale = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
  const pieces = useRef(
    Array.from({ length: PIECES }).map(() => ({
      x: Math.random() * (width - 24),
      delay: Math.random() * 250,
      dur: 900 + Math.random() * 600,
      emoji: EMOJI[Math.floor(Math.random() * EMOJI.length)],
      fall: new Animated.Value(0),
    })),
  ).current;

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
  }, []);

  useEffect(() => {
    if (!visible) return;
    haptic.success();
    scale.setValue(0);
    fade.setValue(1);
    Animated.spring(scale, { toValue: 1, friction: 6, tension: 120, useNativeDriver: true }).start();
    if (!reduceMotion) {
      pieces.forEach((p) => {
        p.fall.setValue(0);
        Animated.timing(p.fall, { toValue: 1, duration: p.dur, delay: p.delay, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
      });
    }
    const fadeOut = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    }, CELEBRATION_MS - 300);
    const done = setTimeout(onDone, CELEBRATION_MS);
    return () => { clearTimeout(fadeOut); clearTimeout(done); };
  }, [visible]);

  if (!visible) return null;

  return (
    <View pointerEvents="none" style={styles.overlay}>
      {!reduceMotion && pieces.map((p, i) => (
        <Animated.Text
          key={i}
          style={[
            styles.piece,
            {
              left: p.x,
              transform: [
                { translateY: p.fall.interpolate({ inputRange: [0, 1], outputRange: [-40, height * 0.8] }) },
                { rotate: p.fall.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
              ],
              opacity: p.fall.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0] }),
            },
          ]}
        >
          {p.emoji}
        </Animated.Text>
      ))}
      <Animated.View style={[styles.card, { opacity: fade, transform: [{ scale }] }]}>
        <View style={styles.check}><Text style={styles.checkMark}>✓</Text></View>
        <Text style={styles.title}>You&apos;re in!</Text>
        <Text style={styles.sub}>Checked in — enjoy the event 🎉</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', zIndex: 50, elevation: 50 },
  piece: { position: 'absolute', top: 0, fontSize: 22 },
  card: {
    backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 30, paddingVertical: 22, alignItems: 'center',
    shadowColor: '#032F4C', shadowOpacity: 0.22, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 12,
  },
  check: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#D1FAE5', alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 30, color: '#059669', fontWeight: '900' },
  title: { marginTop: 12, fontSize: 20, fontWeight: '900', color: colors.textPrimary },
  sub: { marginTop: 4, fontSize: 14, color: colors.textSecondary },
});
