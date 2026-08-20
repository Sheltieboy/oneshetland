/**
 * PeerieFill — "describe it and Peerie Bot fills the form", app side.
 *
 * The RN twin of the web component. Drop it at the top of any create form:
 * give it a parse endpoint, a placeholder, the section accent, and an `onFill`
 * that maps the returned fields onto the form's state. It owns the text box and
 * its own busy/error/done state, and cycles its border through the ring colours
 * while working. Peerie Bot only ever pre-fills — the user reviews and edits
 * before submitting, which is why nothing here writes to the database.
 *
 * The endpoints are the web's `/api/ai/parse-*` routes (see constants/peerie),
 * so app and web share one tuned prompt per form.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { PEERIE } from '@/constants/peerie';
import { AiGlow } from '@/components/ai/AiGlow';
import { peerieHeaders } from '@/lib/peerie-auth';

export function PeerieFill({
  endpoint,
  placeholder,
  accent,
  instruction,
  onFill,
  onBusyChange,
}: {
  endpoint: string;
  placeholder: string;
  accent: string;
  instruction?: string;
  onFill: (data: Record<string, unknown>) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    const body = text.trim();
    if (!body) return;
    setError(null); setDone(false); setBusy(true); onBusyChange?.(true);
    try {
      // The website's AI routes now require a signed-in user. The app has no
      // cookies, so it carries the Supabase session as a Bearer token.
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: await peerieHeaders(),
        body: JSON.stringify({ text: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `${PEERIE.name} couldn't read that.`);
      onFill(data as Record<string, unknown>);
      setDone(true);
    } catch (e) {
      // A failed parse must never block the form — the user can still type it
      // all in by hand, so this reads as a nudge rather than an error state.
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false); onBusyChange?.(false);
    }
  }

  return (
    <AiGlow active={busy} style={styles.card}>
      <View style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: accent }]}>
          <Text style={styles.spark}>{PEERIE.spark}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{PEERIE.name}</Text>
          <Text style={styles.role}>{PEERIE.role}</Text>
        </View>
        <View style={styles.tag}><Text style={styles.tagText}>{PEERIE.tag}</Text></View>
      </View>

      <Text style={styles.instruction}>
        {instruction ??
          `Describe it in plain English and ${PEERIE.name} will fill in the form below — check and tweak anything before you post.`}
      </Text>

      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.textLight}
        multiline
        numberOfLines={4}
        editable={!busy}
        style={styles.input}
        textAlignVertical="top"
      />

      <TouchableOpacity
        onPress={run}
        disabled={busy || !text.trim()}
        activeOpacity={0.85}
        style={[styles.button, { backgroundColor: accent }, (busy || !text.trim()) && styles.buttonOff]}
      >
        {busy ? (
          <>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.buttonText}>{PEERIE.name} is working…</Text>
          </>
        ) : (
          <Text style={styles.buttonText}>{PEERIE.spark}  Fill in with {PEERIE.name}</Text>
        )}
      </TouchableOpacity>

      {done && !busy ? <Text style={styles.done}>Filled in below — have a look ✓</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </AiGlow>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBackground,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  spark: { fontSize: fontSize.md },
  name: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  role: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  tag: { backgroundColor: colors.offWhite, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5 },
  instruction: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.md, minHeight: 96, fontSize: fontSize.md, color: colors.textPrimary,
    backgroundColor: colors.white,
  },
  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    borderRadius: radius.full, paddingVertical: 13, paddingHorizontal: 20,
  },
  buttonOff: { opacity: 0.5 },
  buttonText: { color: colors.textInverse, fontWeight: '800', fontSize: fontSize.md },
  done: { fontSize: fontSize.sm, fontWeight: '700', color: colors.successDark },
  error: { fontSize: fontSize.sm, fontWeight: '600', color: colors.error },
});
