import React, { useEffect, useRef } from 'react';
import { Modal, View, Text, Animated, Easing, StyleSheet, Dimensions, Pressable } from 'react-native';
import { colors } from '@/constants/theme';

const { width, height } = Dimensions.get('window');
const EMOJI = ['🎉', '🎊', '✨', '🎈', '⭐️'];
const PIECES = 18;

/**
 * A brief "you're in — enjoy!" celebration shown when the holder's ticket is
 * checked in at the door (status → 'used'). Built with the RN Animated API only
 * (no extra deps): a spring-in check card + falling emoji confetti. Auto-dismisses.
 */
export function TicketCelebration({ visible, onDone }: { visible: boolean; onDone: () => void }) {
  const scale = useRef(new Animated.Value(0)).current;
  const pieces = useRef(
    Array.from({ length: PIECES }).map(() => ({
      x: Math.random() * width,
      delay: Math.random() * 400,
      dur: 2200 + Math.random() * 1500,
      emoji: EMOJI[Math.floor(Math.random() * EMOJI.length)],
      fall: new Animated.Value(0),
    })),
  ).current;

  useEffect(() => {
    if (!visible) return;
    scale.setValue(0);
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }).start();
    pieces.forEach((p) => {
      p.fall.setValue(0);
      Animated.timing(p.fall, { toValue: 1, duration: p.dur, delay: p.delay, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
    });
    const t = setTimeout(onDone, 4500);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onDone}>
      <Pressable style={styles.backdrop} onPress={onDone}>
        {pieces.map((p, i) => (
          <Animated.Text
            key={i}
            style={[
              styles.piece,
              {
                left: p.x,
                transform: [
                  { translateY: p.fall.interpolate({ inputRange: [0, 1], outputRange: [-40, height + 40] }) },
                  { rotate: p.fall.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '540deg'] }) },
                ],
                opacity: p.fall.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] }),
              },
            ]}
          >
            {p.emoji}
          </Animated.Text>
        ))}
        <Animated.View style={[styles.card, { transform: [{ scale }] }]}>
          <View style={styles.check}><Text style={styles.checkMark}>✓</Text></View>
          <Text style={styles.title}>You&apos;re in!</Text>
          <Text style={styles.sub}>Checked in — enjoy the event 🎉</Text>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(3,47,76,0.28)' },
  piece: { position: 'absolute', top: 0, fontSize: 22 },
  card: {
    backgroundColor: '#fff', borderRadius: 24, paddingHorizontal: 34, paddingVertical: 28, alignItems: 'center',
    shadowColor: '#032F4C', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12,
  },
  check: { width: 66, height: 66, borderRadius: 33, backgroundColor: '#D1FAE5', alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 34, color: '#059669', fontWeight: '900' },
  title: { marginTop: 14, fontSize: 22, fontWeight: '900', color: colors.textPrimary },
  sub: { marginTop: 4, fontSize: 14, color: colors.textSecondary },
});
