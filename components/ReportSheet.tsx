/**
 * components/ReportSheet.tsx
 *
 * The app-store-required "Report this content" flow (Apple Guideline 1.2 /
 * Google Play UGC policy). A bottom sheet that lists the standard report
 * reasons, takes an optional free-text detail, and files a report via
 * reportContent(). Closes on a brief "thanks, we'll review" confirmation.
 *
 * Built on the canonical <Sheet> drawer so it matches every other in-place
 * task in the app.
 *
 *   <ReportSheet
 *     visible={reporting}
 *     onClose={() => setReporting(false)}
 *     contentType="memory_comment"
 *     contentId={comment.id}
 *     reportedUserId={comment.author_id}
 *   />
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { Sheet } from '@/components/ui/Sheet';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import {
  reportContent, REPORT_REASONS, ReportContentType,
} from '@/lib/moderation';

interface Props {
  visible: boolean;
  onClose: () => void;
  contentType: ReportContentType;
  contentId: string;
  /** The author of the reported content, when known. */
  reportedUserId?: string | null;
}

export function ReportSheet({
  visible, onClose, contentType, contentId, reportedUserId,
}: Props) {
  const [reason, setReason]   = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy]       = useState(false);
  const [done, setDone]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Reset whenever the sheet is (re)opened for a fresh piece of content.
  useEffect(() => {
    if (visible) {
      setReason(null);
      setDetails('');
      setBusy(false);
      setDone(false);
      setError(null);
    }
  }, [visible, contentId]);

  const submit = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reportContent({
        contentType,
        contentId,
        reportedUserId: reportedUserId ?? null,
        reason,
        details: details.trim() || null,
      });
      setDone(true);
      // Auto-close after a beat so the user reads the confirmation.
      setTimeout(() => onClose(), 1600);
    } catch (err: any) {
      setError(err?.message ?? 'Could not send your report. Please try again.');
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={done ? undefined : 'Report this'} scroll maxHeightPct={0.85}>
      {done ? (
        <View style={styles.doneWrap}>
          <View style={styles.doneIcon}>
            <FontAwesome5 name="check" size={22} color={colors.success} solid />
          </View>
          <Text style={styles.doneTitle}>Thanks — we'll review this within 24 hours</Text>
          <Text style={styles.doneBody}>
            Our team looks at every report. You won't hear back individually, but
            we take action where it's needed.
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.intro}>
            What's wrong with this? Pick the closest reason — you can add more below.
          </Text>

          <View style={styles.reasons}>
            {REPORT_REASONS.map(r => {
              const active = reason === r.key;
              return (
                <TouchableOpacity
                  key={r.key}
                  onPress={() => setReason(r.key)}
                  activeOpacity={0.8}
                  style={[styles.reasonRow, active && styles.reasonRowActive]}
                >
                  <View style={[styles.radio, active && styles.radioActive]}>
                    {active ? <View style={styles.radioDot} /> : null}
                  </View>
                  <Text style={[styles.reasonLabel, active && styles.reasonLabelActive]}>
                    {r.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.detailsLabel}>Anything else? (optional)</Text>
          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder="Add any detail that helps us understand…"
            placeholderTextColor={colors.textLight}
            multiline
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            onPress={submit}
            disabled={!reason || busy}
            activeOpacity={0.85}
            style={[styles.submitBtn, (!reason || busy) && { opacity: 0.5 }]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>Submit report</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={onClose} disabled={busy} style={styles.cancelBtn} hitSlop={8}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  intro: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  reasons: {
    gap: spacing.xs,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
  reasonRowActive: {
    borderColor: colors.navy,
    backgroundColor: colors.offWhite,
  },
  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: colors.borderStrong,
    alignItems: 'center', justifyContent: 'center',
  },
  radioActive: { borderColor: colors.navy },
  radioDot: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: colors.navy,
  },
  reasonLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  reasonLabelActive: { fontWeight: '700' },
  detailsLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    backgroundColor: colors.white,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  error: {
    fontSize: fontSize.sm,
    color: colors.error,
    marginTop: spacing.md,
  },
  submitBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.navy,
    borderRadius: radius.lg,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  cancelBtn: { marginTop: spacing.sm, alignItems: 'center', paddingVertical: 10 },
  cancelText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },

  // Confirmation state
  doneWrap: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  doneIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.successLight,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  doneTitle: {
    fontSize: fontSize.lg,
    fontWeight: '900',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  doneBody: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: spacing.md,
  },
});
