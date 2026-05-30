/**
 * components/BrandedAlert.tsx
 *
 * Drop-in replacement for React Native's Alert.alert with on-brand styling.
 * Provided once at the app root via <BrandedAlertProvider>, consumed via
 * the useAlert() hook anywhere in the tree.
 *
 * Usage:
 *   const { alert } = useAlert();
 *   alert({
 *     title:   'Upgrade to Premium?',
 *     message: 'You\'ll pay £15.34 today...',
 *     icon:    'crown',
 *     accent:  '#A855F7',
 *     actions: [
 *       { label: 'Cancel',  style: 'cancel' },
 *       { label: 'Confirm', style: 'primary', onPress: () => apply() },
 *     ],
 *   });
 *
 * Differences from Alert.alert:
 *   • Branded look (rounded card, configurable accent, optional icon)
 *   • Supports 'primary' | 'cancel' | 'destructive' | 'secondary' button styles
 *   • Up to 3 actions; renders as a column for >2 to avoid cramming
 *   • Returns nothing (use onPress handlers, same as Alert.alert)
 */

import React, { createContext, useContext, useState, useCallback } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Animated, Easing,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

export type AlertActionStyle = 'primary' | 'cancel' | 'destructive' | 'secondary';

export interface AlertAction {
  label:    string;
  style?:   AlertActionStyle;       // default: 'secondary'
  onPress?: () => void;
}

export interface AlertOptions {
  title:    string;
  message?: string;
  icon?:    string;                 // FontAwesome5 name
  accent?:  string;                 // hex colour for icon + primary button
  actions?: AlertAction[];          // default: [{ label: 'OK', style: 'primary' }]
  dismissible?: boolean;            // tap backdrop to dismiss (default true)
}

interface AlertContextValue {
  alert: (options: AlertOptions) => void;
  hide:  () => void;
}

const AlertContext = createContext<AlertContextValue | null>(null);

export function useAlert(): AlertContextValue {
  const ctx = useContext(AlertContext);
  if (!ctx) {
    throw new Error('useAlert must be used inside <BrandedAlertProvider>');
  }
  return ctx;
}

export function BrandedAlertProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<AlertOptions | null>(null);
  const [visible, setVisible] = useState(false);
  const fade  = React.useRef(new Animated.Value(0)).current;
  const scale = React.useRef(new Animated.Value(0.9)).current;

  const show = useCallback((opts: AlertOptions) => {
    setOptions(opts);
    setVisible(true);
    fade.setValue(0);
    scale.setValue(0.9);
    Animated.parallel([
      Animated.timing(fade,  { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }),
    ]).start();
    Haptics.selectionAsync();
  }, [fade, scale]);

  const hide = useCallback(() => {
    Animated.parallel([
      Animated.timing(fade,  { toValue: 0, duration: 140, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 0.95, duration: 140, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
    ]).start(() => {
      setVisible(false);
      setOptions(null);
    });
  }, [fade, scale]);

  const handleAction = (action: AlertAction) => {
    hide();
    setTimeout(() => action.onPress?.(), 150); // wait for dismiss animation
  };

  const actions: AlertAction[] = options?.actions ?? [{ label: 'OK', style: 'primary' }];
  const accent = options?.accent ?? colors.navy;
  // 2-or-fewer → row, 3+ → column to avoid cramping
  const isColumn = actions.length > 2;

  return (
    <AlertContext.Provider value={{ alert: show, hide }}>
      {children}
      <Modal
        transparent
        visible={visible}
        animationType="none"
        onRequestClose={() => options?.dismissible !== false && hide()}
      >
        <Animated.View style={[styles.backdrop, { opacity: fade }]}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => options?.dismissible !== false && hide()}
          />
          <Animated.View
            style={[
              styles.card,
              { transform: [{ scale }], opacity: fade },
            ]}
          >
            {options?.icon && (
              <View style={[styles.iconWrap, { backgroundColor: accent + '1A' }]}>
                <FontAwesome5 name={options.icon as any} size={20} color={accent} solid />
              </View>
            )}

            {options?.title && <Text style={styles.title}>{options.title}</Text>}
            {options?.message && <Text style={styles.message}>{options.message}</Text>}

            <View style={[styles.actionsRow, isColumn && styles.actionsColumn]}>
              {actions.map((action, i) => (
                <ActionButton
                  key={`${action.label}-${i}`}
                  action={action}
                  accent={accent}
                  fullWidth={isColumn}
                  onPress={() => handleAction(action)}
                />
              ))}
            </View>
          </Animated.View>
        </Animated.View>
      </Modal>
    </AlertContext.Provider>
  );
}

// ── Action button ────────────────────────────────────────────────────────────

function ActionButton({
  action, accent, fullWidth, onPress,
}: {
  action: AlertAction;
  accent: string;
  fullWidth: boolean;
  onPress: () => void;
}) {
  const style = action.style ?? 'secondary';
  const visual = BUTTON_STYLES[style](accent);

  return (
    <TouchableOpacity
      style={[
        styles.btn,
        fullWidth ? styles.btnFullWidth : styles.btnFlex,
        visual.container,
      ]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Text style={[styles.btnText, visual.text]}>{action.label}</Text>
    </TouchableOpacity>
  );
}

const BUTTON_STYLES: Record<AlertActionStyle, (accent: string) => { container: any; text: any }> = {
  primary: (accent) => ({
    container: { backgroundColor: accent },
    text:      { color: '#fff', fontWeight: '800' as const },
  }),
  cancel: () => ({
    container: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border },
    text:      { color: colors.textMuted, fontWeight: '700' as const },
  }),
  destructive: () => ({
    container: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.error },
    text:      { color: colors.error, fontWeight: '800' as const },
  }),
  secondary: () => ({
    container: { backgroundColor: colors.screenBackground, borderWidth: 1, borderColor: colors.border },
    text:      { color: colors.textPrimary, fontWeight: '700' as const },
  }),
};

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 28, 38, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: spacing.lg,
    gap: 12,
    alignItems: 'center',
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 12,
  },
  iconWrap: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: '900',
    color: colors.textPrimary,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  message: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    width: '100%',
    marginTop: 6,
  },
  actionsColumn: {
    flexDirection: 'column',
  },
  btn: {
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnFlex:      { flex: 1 },
  btnFullWidth: { width: '100%' },
  btnText:      { fontSize: fontSize.sm },
});
