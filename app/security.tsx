import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';

type Msg = { ok: boolean; text: string } | null;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function StatusMsg({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <View style={[styles.msg, { backgroundColor: msg.ok ? colors.success + '18' : colors.error + '18' }]}>
      <FontAwesome5
        name={msg.ok ? 'check-circle' : 'exclamation-circle'}
        size={12}
        color={msg.ok ? colors.success : colors.error}
        solid
      />
      <Text style={[styles.msgText, { color: msg.ok ? colors.success : colors.error }]}>{msg.text}</Text>
    </View>
  );
}

export default function SecurityScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { screenWidth } = useAppLayout();

  const currentEmail = session?.user.email ?? '';

  const [email, setEmail] = useState(currentEmail);
  const [emailMsg, setEmailMsg] = useState<Msg>(null);
  const [emailBusy, setEmailBusy] = useState(false);

  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwMsg, setPwMsg] = useState<Msg>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const changeEmail = async () => {
    const next = email.trim();
    if (!next || next === currentEmail) return;
    setEmailBusy(true);
    setEmailMsg(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const { error } = await supabase.auth.updateUser({ email: next });
    setEmailBusy(false);
    if (error) {
      setEmailMsg({ ok: false, text: error.message });
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEmailMsg({ ok: true, text: 'Check both inboxes to confirm the change — you must click the link in each.' });
    }
  };

  const changePassword = async () => {
    if (pw.length < 8) { setPwMsg({ ok: false, text: 'Use at least 8 characters.' }); return; }
    if (pw !== pw2)    { setPwMsg({ ok: false, text: "Passwords don't match." }); return; }
    setPwBusy(true);
    setPwMsg(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setPwBusy(false);
    if (error) {
      setPwMsg({ ok: false, text: error.message });
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPwMsg({ ok: true, text: 'Password updated.' });
      setPw('');
      setPw2('');
    }
  };

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Password & security" accent={colors.navy} onBack={() => router.back()} />}
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Email ──────────────────────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Email address</Text>

            <Field label="Email">
              <View style={styles.inputWrap}>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.textLight}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
              </View>
            </Field>

            <StatusMsg msg={emailMsg} />

            <Text style={styles.hint}>
              Changing your email needs confirming in two inboxes — both the old and new address get a link, and you must click each.
            </Text>

            <Button
              label="Update email"
              icon="envelope"
              onPress={changeEmail}
              disabled={!email.trim() || email.trim() === currentEmail}
              loading={emailBusy}
              fullWidth
              style={styles.cardBtn}
            />
          </View>

          {/* ── Password ───────────────────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Password</Text>

            <Field label="New password">
              <View style={styles.inputWrap}>
                <TextInput
                  style={styles.input}
                  value={pw}
                  onChangeText={setPw}
                  placeholder="New password"
                  placeholderTextColor={colors.textLight}
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="new-password"
                  textContentType="newPassword"
                />
              </View>
            </Field>

            <Field label="Confirm new password">
              <View style={styles.inputWrap}>
                <TextInput
                  style={styles.input}
                  value={pw2}
                  onChangeText={setPw2}
                  placeholder="Confirm new password"
                  placeholderTextColor={colors.textLight}
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="new-password"
                  textContentType="newPassword"
                />
              </View>
            </Field>

            <StatusMsg msg={pwMsg} />

            <Text style={styles.hint}>At least 8 characters.</Text>

            <Button
              label="Change password"
              icon="key"
              onPress={changePassword}
              disabled={!pw || !pw2}
              loading={pwBusy}
              fullWidth
              style={styles.cardBtn}
            />
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md, paddingBottom: 60, gap: 12 },

  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  cardTitle: {
    fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  cardBtn: { marginTop: 8 },

  field:      { marginBottom: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  hint:       { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 6, lineHeight: 16 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, minHeight: 46,
  },
  input: { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm, paddingVertical: 12 },

  msg: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: radius.md, padding: 10, marginTop: 4,
  },
  msgText: { flex: 1, fontSize: fontSize.xs, fontWeight: '600', lineHeight: 16 },
});
