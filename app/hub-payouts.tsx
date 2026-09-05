/**
 * hub-payouts.tsx
 * Hub owner/committee: connect or manage where Hub payments are paid.
 * Pass ?id=<hubId>.
 *
 * Mobile had the onboarding CALL (createHubOnboardingLink) but no screen and no
 * entry point — it was reachable only from the membership-tiers warning, and
 * that warning appeared only once a paid tier already existed. Hub Manage now
 * has a Payouts row, and this is where it goes.
 *
 * Readiness comes from hub_payout_ready(): the hub's own connected account with
 * payouts enabled. hubs.stripe_account_id is granted to no client role and is
 * never read here.
 */

import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchHub, fetchHubPayoutReady, createHubOnboardingLink, type Hub } from '@/lib/hubs-api';
import { hubPayoutNotice } from '@/lib/hub-payout-notice';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAlert } from '@/components/BrandedAlert';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';

const S = SECTIONS.community;

export default function HubPayoutsScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [hub, setHub] = useState<Hub | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [onboarding, setOnboarding] = useState(false);

  const load = useCallback(async () => {
    try {
      if (!id) { setHub(null); return; }
      const [h, r] = await Promise.all([
        fetchHub(id).catch(() => null),
        fetchHubPayoutReady(id).catch(() => false),
      ]);
      setHub(h);
      setReady(r);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const setUpPayouts = async () => {
    if (!id) return;
    setOnboarding(true);
    try {
      const { url } = await createHubOnboardingLink(id);
      await Linking.openURL(url);
    } catch (e: any) {
      alert({ title: 'Could not start payout setup', message: e?.message ?? 'Please try again.' });
    } finally { setOnboarding(false); }
  };

  if (loading) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Payouts" accent={S.color} />}>
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  if (!hub) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Payouts" accent={S.color} />}>
        <EmptyState
          icon="university"
          title={id ? 'Hub not found.' : 'No hub chosen — open this from Hub Manage.'}
          body="Payout setup belongs to a particular hub."
          accent={S.color}
          variant="card"
        />
      </ScreenScaffold>
    );
  }

  const notice = hubPayoutNotice(ready);

  return (
    <ScreenScaffold header={<ScreenHeader title="Payouts" accent={S.color} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
        <Text style={styles.intro}>
          Connect or manage where Hub payments are paid. Money from paid memberships and donations
          goes straight to your hub — OneShetland keeps only its fee.
        </Text>

        <View style={ready ? styles.okCard : styles.warnCard}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <FontAwesome5
              name={ready ? 'check-circle' : 'exclamation-circle'}
              size={14}
              color={ready ? '#15803D' : '#B45309'}
              solid
              style={{ marginTop: 2 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={ready ? styles.okTitle : styles.warnTitle}>{notice.title}</Text>
              <Text style={ready ? styles.okText : styles.warnText}>{notice.body}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.payoutBtn} onPress={setUpPayouts} disabled={onboarding} activeOpacity={0.85}>
            {onboarding ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <FontAwesome5 name="university" size={12} color="#fff" solid />
                <Text style={styles.payoutBtnText}>{notice.cta}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.footnote}>
          Powered by Stripe Connect. Your payout status updates automatically once Stripe confirms
          the account.
        </Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  intro: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
  warnCard: { backgroundColor: '#FEF3C7', borderRadius: radius.lg, padding: spacing.md, gap: spacing.md },
  warnTitle: { fontSize: fontSize.sm, fontWeight: '800', color: '#92400E', marginBottom: 2 },
  warnText: { fontSize: fontSize.xs, color: '#92400E', lineHeight: 18 },
  okCard: { backgroundColor: '#DCFCE7', borderRadius: radius.lg, padding: spacing.md, gap: spacing.md },
  okTitle: { fontSize: fontSize.sm, fontWeight: '800', color: '#166534', marginBottom: 2 },
  okText: { fontSize: fontSize.xs, color: '#166534', lineHeight: 18 },
  payoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: S.color, borderRadius: radius.full, paddingVertical: 11,
  },
  payoutBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  footnote: { fontSize: fontSize.xs, color: colors.textLight, lineHeight: 17 },
});
