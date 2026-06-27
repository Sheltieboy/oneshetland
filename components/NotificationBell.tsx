/**
 * NotificationBell
 *
 * Brand-row button that opens the in-app notification inbox and shows an unread
 * badge. Refreshes the count whenever the screen regains focus. Renders nothing
 * for signed-out users.
 */
import React, { useCallback, useState } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { fetchUnreadCount } from '@/lib/notifications-inbox';

export function NotificationBell({ size = 34 }: { size?: number } = {}) {
  const router = useRouter();
  const { profile } = useAuth();
  const [count, setCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (profile) {
        fetchUnreadCount().then(c => { if (active) setCount(c); }).catch(() => {});
      } else {
        setCount(0);
      }
      return () => { active = false; };
    }, [profile?.id]),
  );

  if (!profile) return null;

  return (
    <TouchableOpacity
      style={[styles.btn, { width: size, height: size, borderRadius: size / 2 }]}
      onPress={() => router.push('/notifications')}
      activeOpacity={0.8}
      hitSlop={8}
      accessibilityLabel={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
    >
      <FontAwesome5 name="bell" size={Math.round(size * 0.42)} color={colors.navy} solid />
      {count > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(3,47,76,0.12)',
  },
  badge: {
    position: 'absolute', top: -3, right: -3,
    minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: '#E53935',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
});
