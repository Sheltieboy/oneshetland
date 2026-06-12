/**
 * hub-broadcast.tsx
 * Message the whole active membership of a hub (owner/committee only).
 * Pass ?id=<hubId>.
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { broadcastToHub } from '@/lib/hubs-api';

const S = SECTIONS.community;

const CHANNELS: { key: 'push' | 'email' | 'both'; label: string; icon: string }[] = [
  { key: 'push',  label: 'Push',  icon: 'bell' },
  { key: 'email', label: 'Email', icon: 'envelope' },
  { key: 'both',  label: 'Both',  icon: 'paper-plane' },
];

export default function HubBroadcastScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState<'push' | 'email' | 'both'>('push');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!id) return;
    if (!title.trim() || !message.trim()) { Alert.alert('Add a subject and message', 'Both are needed.'); return; }
    Alert.alert('Send to all members?', `This will ${channel === 'push' ? 'push-notify' : channel === 'email' ? 'email' : 'push and email'} every active member.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send', onPress: async () => {
          setSending(true);
          try {
            const res = await broadcastToHub(id, { title: title.trim(), message: message.trim(), channel });
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Sent', `Reached ${res.members} member${res.members === 1 ? '' : 's'}` +
              `${channel !== 'email' ? ` · ${res.push} push` : ''}${channel !== 'push' ? ` · ${res.email} email` : ''}.`,
              [{ text: 'Done', onPress: () => router.back() }]);
          } catch (e: any) {
            Alert.alert('Could not send', e?.message ?? 'Please try again.');
          } finally { setSending(false); }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={{ width: 70 }}>
          <Text style={[styles.cancel, { color: S.color }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Message members</Text>
        <View style={{ width: 70 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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

          <TouchableOpacity style={[styles.sendBtn, { backgroundColor: S.color }, sending && { opacity: 0.6 }]} onPress={send} disabled={sending} activeOpacity={0.85}>
            {sending ? <ActivityIndicator color="#fff" /> : (
              <>
                <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
                <Text style={styles.sendText}>Send to members</Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff',
  },
  cancel: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.md },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary },
  textarea: { minHeight: 130, textAlignVertical: 'top' },

  channelRow: { flexDirection: 'row', gap: 8 },
  channelBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  channelText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  note: { fontSize: fontSize.xs, color: colors.textLight, marginTop: spacing.md, lineHeight: 17 },
  sendBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: spacing.lg, borderRadius: radius.lg, paddingVertical: 16 },
  sendText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
