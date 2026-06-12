/**
 * AlertPill.tsx — Floating urgent alert shown app-wide.
 *
 * Sits at the top of the screen (above the hero image).
 * Slides in with a spring animation. Dismissible per-session.
 * Colour-coded by severity: red = emergency, amber = disruption, blue = info.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, TouchableOpacity, View, Text, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import type { PartnerAlert, AlertType } from '@/lib/alerts-api';

// ── Type metadata ────────────────────────────────────────────────────────────

interface AlertMeta {
  color:    string;
  bg:       string;       // pill background
  icon:     string;
  label:    string;
}

const ALERT_META: Record<AlertType, AlertMeta> = {
  emergency:  { color: '#FF3B30', bg: 'rgba(12,8,8,0.96)',   icon: 'exclamation-triangle', label: 'EMERGENCY'  },
  disruption: { color: '#FF9500', bg: 'rgba(12,10,4,0.96)',  icon: 'exclamation-circle',   label: 'DISRUPTION' },
  info:       { color: '#0A84FF', bg: 'rgba(4,10,20,0.96)',  icon: 'info-circle',           label: 'ALERT'      },
};

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  alert:     PartnerAlert;
  onDismiss: (id: string) => void;
  onPress?:  () => void;
}

export default function AlertPill({ alert, onDismiss, onPress }: Props) {
  const insets  = useSafeAreaInsets();
  const { contentWidth, sidePadding } = useAppLayout();
  // Cap pill width to the usable content area so it doesn't stretch across a tablet
  const pillW = contentWidth - spacing.lg * 2;
  const pillLeft = sidePadding + spacing.lg;
  const translateY = useRef(new Animated.Value(-80)).current;
  const opacity    = useRef(new Animated.Value(0)).current;
  const [expanded, setExpanded] = useState(false);

  const meta = ALERT_META[alert.type] ?? ALERT_META.info;

  // Slide in on mount
  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        damping:   18,
        stiffness: 220,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const dismiss = () => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: -80,
        damping: 20,
        stiffness: 260,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 140,
        useNativeDriver: true,
      }),
    ]).start(() => onDismiss(alert.id));
  };

  const expiresLabel = alert.expires_at
    ? (() => {
        const d = new Date(alert.expires_at);
        const now = new Date();
        const diffH = Math.round((d.getTime() - now.getTime()) / 3_600_000);
        if (diffH < 1) return 'Expires soon';
        if (diffH < 24) return `Until ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
        return `Until ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
      })()
    : null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top:             insets.top + 8,
          left:            pillLeft,
          width:           pillW,
          transform:       [{ translateY }],
          opacity,
          backgroundColor: meta.bg,
        },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        style={styles.inner}
        onPress={() => {
          setExpanded(e => !e);
          onPress?.();
        }}
        activeOpacity={0.9}
      >
        {/* Left: colour bar */}
        <View style={[styles.colorBar, { backgroundColor: meta.color }]} />

        {/* Icon */}
        <View style={[styles.iconWrap, { backgroundColor: meta.color + '22' }]}>
          <FontAwesome5 name={meta.icon} size={13} color={meta.color} solid />
        </View>

        {/* Content */}
        <View style={styles.content}>
          <View style={styles.topRow}>
            <Text style={[styles.typeLabel, { color: meta.color }]}>{meta.label}</Text>
            <Text style={styles.source} numberOfLines={1}>{alert.business_name}</Text>
            {expiresLabel ? (
              <Text style={styles.expires}>{expiresLabel}</Text>
            ) : null}
          </View>
          <Text
            style={styles.message}
            numberOfLines={expanded ? 4 : 1}
          >
            {alert.message}
          </Text>
        </View>

        {/* Dismiss */}
        <TouchableOpacity
          style={styles.dismissBtn}
          onPress={dismiss}
          hitSlop={12}
        >
          <FontAwesome5 name="times" size={11} color="rgba(255,255,255,0.45)" />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position:     'absolute',
    zIndex:       999,
    borderRadius: 16,
    shadowColor:  '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation:    12,
    overflow:     'hidden',
  },
  inner: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           10,
    paddingVertical:  12,
    paddingRight:  14,
  },
  colorBar: {
    width: 4,
    alignSelf: 'stretch',
    minHeight: 40,
  },
  iconWrap: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  content: {
    flex: 1,
    gap:  2,
  },
  topRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
  },
  typeLabel: {
    fontSize:      9,
    fontWeight:    '900',
    letterSpacing: 1.2,
  },
  source: {
    fontSize:   10,
    color:      'rgba(255,255,255,0.5)',
    fontWeight: '600',
    flex:       1,
  },
  expires: {
    fontSize:   9,
    color:      'rgba(255,255,255,0.4)',
    fontWeight: '600',
  },
  message: {
    fontSize:   13,
    color:      '#fff',
    fontWeight: '700',
    lineHeight: 17,
  },
  dismissBtn: {
    width:  28, height: 28, borderRadius: 14,
    alignItems:     'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    flexShrink: 0,
  },
});
