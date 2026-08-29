import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { fetchCommercialTermsStatus, acceptCommercialTerms } from '@/lib/commercial-terms';

const TERMS_URL = 'https://oneshetland.com/terms#commercial';

/**
 * The app's acceptance surface for the business & selling terms.
 *
 * Wraps a commercial screen. Owning a Directory listing does not make anybody a
 * seller, so this appears only in front of screens that take money, bookings or
 * commitments — never in front of the dashboard, the listing editor, jobs or
 * shifts. One acceptance covers every commercial screen for that business.
 *
 * FAILS CLOSED: while the status is loading, and if it cannot be read at all,
 * the wrapped screen is NOT rendered. "Unknown" is never treated as "accepted".
 * Accepting when the status is unknown is harmless — the writer is idempotent
 * per user, business and version.
 *
 * Its own presentation, but not its own architecture: the same RPCs, event type
 * and version as the website.
 */
export function CommercialTermsGate({
  businessId,
  businessName,
  feature,
  children,
}: {
  businessId: string | undefined;
  businessName?: string;
  feature: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'accepted' | 'needed' | 'unknown'>('loading');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!businessId) { setStatus('unknown'); return; }
    const s = await fetchCommercialTermsStatus(businessId);
    if (!s.known) { setStatus('unknown'); return; }
    setStatus(s.accepted ? 'accepted' : 'needed');
  }, [businessId]);

  useEffect(() => { void load(); }, [load]);

  if (status === 'accepted') return <>{children}</>;

  if (status === 'loading') {
    return (
      <SafeAreaView style={s.fill} edges={['top']}>
        <View style={s.centre}><ActivityIndicator color={colors.navy} /></View>
      </SafeAreaView>
    );
  }

  const name = businessName?.trim() || 'This business';

  async function accept() {
    if (!businessId) return;
    setBusy(true); setError(null);
    try {
      await acceptCommercialTerms(businessId);
      // Re-read rather than assume. The server decides whether this opens.
      await load();
    } catch (e) {
      setError(
        e instanceof Error && /own this business/i.test(e.message)
          ? 'You no longer manage this business, so it can’t be accepted here.'
          : 'We couldn’t record that just now. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.fill} edges={['top']}>
      <ScrollView contentContainerStyle={s.pad}>
        <Text style={s.eyebrow}>BEFORE YOU START SELLING</Text>
        <Text style={s.title}>Accept the business &amp; selling terms</Text>

        <Text style={s.body}>
          <Text style={s.strong}>{name}</Text> is about to use OneShetland&apos;s commercial
          features — {feature.toLowerCase()} is one of them. Managing your Directory listing
          didn&apos;t need this; selling, taking bookings and accepting payments do.
        </Text>

        <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL)}>
          <Text style={s.link}>
            Read section 11 of our Terms — Businesses &amp; selling on OneShetland
          </Text>
        </TouchableOpacity>
        <Text style={s.body}>
          It covers what you&apos;re responsible for as the seller: accurate listings, fulfilling
          what you offer, cancellations and refunds, your own tax, and dealing with customer
          questions.
        </Text>

        <TouchableOpacity style={s.check} onPress={() => setAgreed((v) => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }}>
          <View style={[s.box, agreed && s.boxOn]}>{agreed && <Text style={s.tick}>✓</Text>}</View>
          <Text style={s.checkText}>
            I&apos;m authorised to act for {name}, and I accept the Businesses &amp; selling on
            OneShetland terms for this business.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.cta, (!agreed || busy) && s.ctaOff]}
          disabled={!agreed || busy}
          onPress={() => void accept()}
        >
          <Text style={s.ctaText}>{busy ? 'Recording…' : 'Accept and continue'}</Text>
        </TouchableOpacity>

        {status === 'unknown' && (
          <Text style={s.warn}>
            We couldn&apos;t check whether you&apos;ve already accepted these terms. Accepting
            again is safe — it won&apos;t create a second record.
          </Text>
        )}
        {error && <Text style={s.error}>{error}</Text>}

        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}>
          <Text style={s.back}>Your Directory listing is unaffected — go back</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  fill:      { flex: 1, backgroundColor: colors.screenBackground },
  centre:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad:       { padding: spacing.lg, gap: spacing.md },
  eyebrow:   { fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 1, color: colors.navy },
  title:     { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary },
  body:      { fontSize: fontSize.md, color: colors.textSecondary, lineHeight: 22 },
  strong:    { fontWeight: '700', color: colors.textPrimary },
  link:      { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, textDecorationLine: 'underline' },
  check:     { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start',
               backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.md },
  box:       { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.textMuted,
               alignItems: 'center', justifyContent: 'center' },
  boxOn:     { backgroundColor: colors.navy, borderColor: colors.navy },
  tick:      { color: '#fff', fontWeight: '900' },
  checkText: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
  cta:       { backgroundColor: colors.navy, borderRadius: radius.full, paddingVertical: spacing.md,
               alignItems: 'center' },
  ctaOff:    { opacity: 0.4 },
  ctaText:   { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  warn:      { fontSize: fontSize.sm, color: '#92400E', backgroundColor: '#FEF3C7',
               padding: spacing.sm, borderRadius: radius.md },
  error:     { fontSize: fontSize.sm, color: colors.notices },
  back:      { fontSize: fontSize.sm, color: colors.textSecondary, textDecorationLine: 'underline',
               marginTop: spacing.sm },
});
