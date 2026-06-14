/**
 * hub-broadcast.tsx
 * Message the whole active membership of a hub (owner/committee only).
 * Pass ?id=<hubId>.
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { broadcastToHub } from '@/lib/hubs-api';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.community;

const CHANNELS: { key: 'push' | 'email' | 'both'; label: string; icon: string }[] = [
  { key: 'push',  label: 'Push',  icon: 'bell' },
  { key: 'email', label: 'Email', icon: 'envelope' },
  { key: 'both',  label: 'Both',  icon: 'paper-plane' },
];

export default function HubBroadcastScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState<'push' | 'email' | 'both'>('push');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!id) return;
    if (!title.trim() || !message.trim()) { alert({ title: 'Add a subject and message', message: 'Both are needed.' }); return; }
    alert({
      title: 'Send to all members?',
      message: `This will ${channel === 'push' ? 'push-notify' : channel === 'email' ? 'email' : 'push and email'} every active member.`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Send', style: 'primary', onPress: async () => {
            setSending(true);
            try {
              const res = await broadcastToHub(id, { title: title.trim(), message: message.trim(), channel });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              alert({
                title: 'Sent',
                message: `Reached ${res.members} member${res.members === 1 ? '' : 's'}` +
                  `${channel !== 'email' ? ` · ${res.push} push` : ''}${channel !== 'push' ? ` · ${res.email} email` : ''}.`,
                actions: [{ label: 'Done', style: 'primary', onPress: () => router.back() }],
              });
            } catch (e: any) {
              alert({ title: 'Could not send', message: e?.message ?? 'Please try again.' });
            } finally { setSending(false); }
          },
        },
      ],
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Message members" onClose={() => router.back()} accent={S.color} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Subject</Text>
          <TextInput style={styles.input} value={title} onChangeText={setTitle}
            placeholder="e.g. AGM next Thursday" placeholderTextColor={colors.textLight} />

          <Text style={styles.label}>Message</Text>
          <TextInput style={[styles.input, styles.textarea]} value={message} onChangeText={setMessage}
            placeholder="Write your update to members…" placeholderTextColor={colors.textLight} multiline />

          <Text style={styles.label}>Send via</Text>
          <View style={styles.channelRow}>
            {CHANNELS.map(c => (
              <TouchableOpacity key={c.key} style={[styles.channelBtn, channel === c.key && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => setChannel(c.key)} activeOpacity={0.85}>
                <FontAwesome5 name={c.icon as any} size={13} color={channel === c.key ? '#fff' : colors.textMuted} solid />
                <Text style={[styles.channelText, channel === c.key && { color: '#fff' }]}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.note}>Goes to all current members of the hub. Keep it relevant — members can't opt out of hub messages individually yet.</Text>

          <Button label="Send to members" icon="paper-plane" color={S.color} fullWidth loading={sending} disabled={sending} onPress={send} style={styles.sendBtn} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },

  content: { padding: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.md },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary },
  textarea: { minHeight: 130, textAlignVertical: 'top' },

  channelRow: { flexDirection: 'row', gap: 8 },
  channelBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  channelText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  note: { fontSize: fontSize.xs, color: colors.textLight, marginTop: spacing.md, lineHeight: 17 },
  sendBtn: { marginTop: spacing.lg },
});
