import * as Haptics from 'expo-haptics';

function safe(fn: () => Promise<void>) {
  return () => { fn().catch(() => {}); };
}

export const haptic = {
  light:   safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium:  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy:   safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  success: safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error:   safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  select:  safe(() => Haptics.selectionAsync()),
};
