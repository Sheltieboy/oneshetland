/**
 * local-business-dashboard.tsx
 *
 * Owner view: rotating till code, loyalty program management,
 * offers, wallet onboarding, and quick stats.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Switch, Linking, RefreshControl, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { useStripe } from '@stripe/stripe-react-native';
import { useAlert } from '@/components/BrandedAlert';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyBusinesses, updateBusiness,
  fetchLoyaltyProgram, upsertLoyaltyProgram,
  fetchBusinessOffers, deactivateOffer,
  fetchBusinessCode, refreshBusinessCode,
  createBusinessOnboardingLink, createSubscriptionIntent, createBillingPortalLink,
  previewSubscriptionChange, applySubscriptionChange,
  createBoostIntent, fetchBoostPrices, isOnBoost,
  requestNfcTile, NFC_TILE_URL_PREFIX,
  isBusinessFeatured, TIER_LABELS, TIER_PRICE,
  formatOfferDiscount, daysRemaining,
  type LocalBusiness, type LoyaltyProgram, type LocalOffer, type BusinessCode, type LoyaltyType,
} from '@/lib/local-api';
import { setAcceptsBookings, fetchBusinessServices } from '@/lib/book-api';
import { supabase } from '@/lib/supabase';

const S = SECTIONS.local;

// Tier helpers — single source of truth for "does this user's plan include X?"
type TierLevel = 'free' | 'pro' | 'premium';
const TIER_RANK: Record<TierLevel, number> = { free: 0, pro: 1, premium: 2 };
const tierMeets = (current: TierLevel, required: TierLevel) =>
  TIER_RANK[current] >= TIER_RANK[required];

const PREMIUM_PURPLE = '#A855F7';

// Feature list used by the Plan card's checklist
const PLAN_FEATURES: { label: string; req: TierLevel }[] = [
  { label: 'Directory listing',      req: 'free'    },
  { label: 'Loyalty programme',      req: 'pro'     },
  { label: 'Time-limited offers',    req: 'pro'     },
  { label: 'Local Wallet payments',  req: 'pro'     },
  { label: 'NFC tap-to-stamp tile',  req: 'pro'     },
  { label: 'In-app bookings',        req: 'premium' },
  { label: 'Featured homepage spot', req: 'premium' },
];

export default function BusinessDashboardScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [businesses, setBusinesses] = useState<LocalBusiness[]>([]);
  const [activeBusiness, setActiveBusiness] = useState<LocalBusiness | null>(null);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [offers, setOffers]   = useState<LocalOffer[]>([]);
  const [code, setCode]       = useState<BusinessCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showLoyaltyModal, setShowLoyaltyModal] = useState(false);
  const [bookServiceCount, setBookServiceCount] = useState(0);

  // Backfill state — count of this user's shifts that don't yet have a
  // business linked (posted_as_business_id IS NULL). If > 0, we offer to
  // link them all to the active business.
  const [orphanedShiftCount, setOrphanedShiftCount] = useState(0);
  const [backfilling,        setBackfilling]        = useState(false);

  // Boost prices (loaded from admin_config)
  const [boostPrices, setBoostPrices] = useState<{ one: number | null; two: number | null; three: number | null }>({ one: null, two: null, three: null });
  const [boostBusy,   setBoostBusy]   = useState<1 | 2 | 3 | null>(null);

  useEffect(() => {
    fetchBoostPrices().then(setBoostPrices).catch(() => {});
  }, []);

  const codeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAll = useCallback(async (biz?: LocalBusiness) => {
    if (!profile) return;
    const bizList = await fetchMyBusinesses(profile.id);
    setBusinesses(bizList);
    const target = biz ?? bizList[0];
    setActiveBusiness(target ?? null);
    if (!target) {
      setLoading(false);
      return;
    }
    const [prog, ofs, cd, bookSvcs, orphanCount] = await Promise.all([
      fetchLoyaltyProgram(target.id),
      fetchBusinessOffers(target.id, true),
      fetchBusinessCode(target.id),
      fetchBusinessServices(target.id, false).catch(() => []),
      // Count this user's shifts that have no Local business link yet —
      // used to offer the backfill prompt below.
      supabase
        .from('shifts')
        .select('id', { count: 'exact', head: true })
        .eq('employer_id', profile!.id)
        .is('posted_as_business_id', null)
        .then(({ count }) => count ?? 0)
        .catch(() => 0),
    ]);
    setProgram(prog);
    setOffers(ofs);
    setCode(cd);
    setBookServiceCount(bookSvcs.length);
    setOrphanedShiftCount(orphanCount as number);
    setLoading(false);
    setRefreshing(false);
  }, [profile?.id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-refresh code every 60s while screen is open
  useEffect(() => {
    if (!activeBusiness) return;
    const tick = async () => {
      try {
        const fresh = await refreshBusinessCode(activeBusiness.id);
        setCode(fresh);
      } catch {}
    };
    tick();
    codeTimerRef.current = setInterval(tick, 60_000);
    return () => { if (codeTimerRef.current) clearInterval(codeTimerRef.current); };
  }, [activeBusiness?.id]);

  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { alert: brandedAlert } = useAlert();
  const [upgradeBusy, setUpgradeBusy] = useState(false);

  // EXISTING-SUBSCRIBER flow: preview the proration, ask the user to confirm,
  // then apply. No Payment Sheet — Stripe charges the saved card directly.
  const handleTierChange = async (newTier: 'pro' | 'premium') => {
    if (!activeBusiness) return;
    setUpgradeBusy(true);
    try {
      const preview = await previewSubscriptionChange(activeBusiness.id, newTier);

      if (preview.noChange) {
        Alert.alert('Already on this plan', 'No changes made.');
        return;
      }

      const amount   = (preview.previewAmountPence / 100).toFixed(2);
      const symbol   = preview.currency?.toLowerCase() === 'gbp' ? '£' : preview.currency?.toUpperCase() + ' ';
      const monthly  = newTier === 'premium' ? '£49.99' : '£19.99';
      const tierName = newTier === 'premium' ? 'Premium' : 'Pro';
      const renewDate = preview.nextRenewalAt
        ? new Date(preview.nextRenewalAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'your next billing date';

      const isUpgrade = preview.previewAmountPence > 0;
      const action    = isUpgrade ? 'Upgrade' : 'Switch';

      brandedAlert({
        title:   `${action} to ${tierName}?`,
        message: isUpgrade
          ? `You'll pay ${symbol}${amount} today (unused portion of your current plan is credited).\n\nThen ${monthly}/month from ${renewDate}.`
          : `No charge today — you've been credited for the difference.\n\nThen ${monthly}/month from ${renewDate}.`,
        icon:    newTier === 'premium' ? 'crown' : 'star',
        accent:  newTier === 'premium' ? PREMIUM_PURPLE : S.color,
        actions: [
          { label: 'Cancel', style: 'cancel', onPress: () => setUpgradeBusy(false) },
          {
            label: 'Confirm',
            style: 'primary',
            onPress: async () => {
              try {
                await applySubscriptionChange(activeBusiness.id, newTier);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setActiveBusiness(prev => prev ? { ...prev, subscription_tier: newTier } as LocalBusiness : prev);
                pollForTier(activeBusiness.id, newTier);
              } catch (e: any) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                brandedAlert({
                  title: 'Change failed',
                  message: e?.message ?? 'Try again.',
                  icon: 'exclamation-triangle',
                  accent: colors.error,
                  actions: [{ label: 'OK', style: 'primary' }],
                });
              } finally {
                setUpgradeBusy(false);
              }
            },
          },
        ],
      });
    } catch (e: any) {
      Alert.alert('Could not preview', e?.message ?? 'Try again.');
      setUpgradeBusy(false);
    }
  };

  // After a successful Payment Sheet, poll the businesses table until the
  // webhook has flipped the tier in the DB. Bails after ~20s — by then the
  // optimistic UI is correct enough that the user can carry on.
  const pollForTier = async (businessId: string, expected: 'pro' | 'premium') => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const fresh = await fetchMyBusinesses(profile!.id);
        const updated = fresh.find(b => b.id === businessId);
        if (updated?.subscription_tier === expected || updated?.subscription_tier === 'premium') {
          setBusinesses(fresh);
          setActiveBusiness(updated);
          return;
        }
      } catch { /* keep trying */ }
    }
  };

  const startCheckout = async (tier: 'pro' | 'premium') => {
    if (!activeBusiness || upgradeBusy) return;

    // EXISTING SUBSCRIBER → preview + confirm + apply with proration
    // (no Payment Sheet — saved card is auto-charged for the prorated amount)
    if (activeBusiness.subscription_tier !== 'free' && activeBusiness.stripe_subscription_id) {
      await handleTierChange(tier);
      return;
    }

    // FIRST-TIME SUBSCRIBER → Payment Sheet flow
    setUpgradeBusy(true);
    try {
      // 1. Server: create the incomplete subscription + ephemeral key
      const intent = await createSubscriptionIntent(activeBusiness.id, tier);

      // 2. Init the Payment Sheet with those values
      const { error: initError } = await initPaymentSheet({
        merchantDisplayName:        'OneShetland',
        customerId:                 intent.customer,
        customerEphemeralKeySecret: intent.ephemeralKey,
        paymentIntentClientSecret:  intent.paymentIntent,
        allowsDelayedPaymentMethods: false,
        defaultBillingDetails:      { name: activeBusiness.name },
        returnURL:                  'oneshetland-fetch://stripe-redirect',
      });
      if (initError) throw new Error(initError.message);

      // 3. Present sheet → user pays
      const { error: sheetError } = await presentPaymentSheet();
      if (sheetError) {
        if (sheetError.code === 'Canceled') return;            // user backed out
        throw new Error(sheetError.message);
      }

      // 4. Success — Stripe will fire customer.subscription.updated and our
      //    webhook will flip the tier. There's a small race window so we:
      //    (a) optimistically update the UI right away
      //    (b) poll in the background to confirm the DB caught up (and to
      //        replace the local optimistic value with the authoritative one)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setActiveBusiness(prev => prev ? { ...prev, subscription_tier: tier } as LocalBusiness : prev);

      Alert.alert(
        `Welcome to ${tier === 'premium' ? 'Premium' : 'Pro'}!`,
        'Your subscription is active. The new features are unlocked below.',
      );

      // Poll up to ~20 seconds for the webhook to confirm the tier in the DB
      pollForTier(activeBusiness.id, tier);
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not start checkout', e?.message ?? 'Try again');
    } finally {
      setUpgradeBusy(false);
    }
  };

  const handleBackfillShifts = async () => {
    if (!activeBusiness || !profile) return;
    brandedAlert({
      title:   `Link ${orphanedShiftCount} shift${orphanedShiftCount === 1 ? '' : 's'} to ${activeBusiness.name}?`,
      message: `These were posted before you created a business profile, so workers see your name on them. Linking will switch them to show "${activeBusiness.name}" instead.`,
      icon:    'link',
      accent:  S.color,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Link them',
          style: 'primary',
          onPress: async () => {
            setBackfilling(true);
            try {
              const { error } = await supabase
                .from('shifts')
                .update({ posted_as_business_id: activeBusiness.id })
                .eq('employer_id', profile.id)
                .is('posted_as_business_id', null);
              if (error) throw error;
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setOrphanedShiftCount(0);
            } catch (e: any) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              brandedAlert({
                title: 'Could not link',
                message: e?.message ?? 'Try again.',
                icon: 'exclamation-triangle',
                accent: colors.error,
                actions: [{ label: 'OK', style: 'primary' }],
              });
            } finally {
              setBackfilling(false);
            }
          },
        },
      ],
    });
  };

  const handleBoost = async (weeks: 1 | 2 | 3) => {
    if (!activeBusiness || boostBusy) return;
    setBoostBusy(weeks);
    try {
      // 1. Server: create the PaymentIntent
      const intent = await createBoostIntent(activeBusiness.id, weeks);

      // 2. Init the Payment Sheet
      const { error: initError } = await initPaymentSheet({
        merchantDisplayName:        'OneShetland',
        customerId:                 intent.customer,
        customerEphemeralKeySecret: intent.ephemeralKey,
        paymentIntentClientSecret:  intent.paymentIntent,
        allowsDelayedPaymentMethods: false,
        defaultBillingDetails:      { name: activeBusiness.name },
        returnURL:                  'oneshetland-fetch://stripe-redirect',
      });
      if (initError) throw new Error(initError.message);

      // 3. Present sheet → user pays
      const { error: sheetError } = await presentPaymentSheet();
      if (sheetError) {
        if (sheetError.code === 'Canceled') return;
        throw new Error(sheetError.message);
      }

      // 4. Success — the webhook will flip tier to 'pro' and extend
      //    subscription_until. Optimistic UI + poll to confirm.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const optimisticUntil = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);
      setActiveBusiness(prev => prev ? {
        ...prev,
        subscription_tier:  'pro',
        subscription_until: optimisticUntil.toISOString(),
      } as LocalBusiness : prev);

      brandedAlert({
        title:   `Boost active!`,
        message: `Pro features unlocked for the next ${weeks} week${weeks === 1 ? '' : 's'}. No subscription — just enjoy.`,
        icon:    'bolt',
        accent:  S.color,
        actions: [{ label: 'Great', style: 'primary' }],
      });

      pollForTier(activeBusiness.id, 'pro');
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      brandedAlert({
        title:   'Could not start boost',
        message: e?.message ?? 'Try again.',
        icon:    'exclamation-triangle',
        accent:  colors.error,
        actions: [{ label: 'OK', style: 'primary' }],
      });
    } finally {
      setBoostBusy(null);
    }
  };

  const openBillingPortal = async () => {
    if (!activeBusiness) return;
    try {
      const { url } = await createBillingPortalLink(activeBusiness.id);
      // Present as an in-app SFSafariViewController modal (iOS) /
      // CustomTabs (Android) — slides up from the bottom like a sheet,
      // user taps Done to close. Doesn't leave the app.
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor:     S.color,
        toolbarColor:      '#ffffff',
        dismissButtonStyle:'close',
      });
      // When the user closes the sheet, refresh the dashboard so any
      // cancellation pending state shows up immediately.
      loadAll(activeBusiness);
    } catch (e: any) {
      Alert.alert('Could not open billing', e?.message ?? 'Try again');
    }
  };

  const handleConnectStripe = async () => {
    if (!activeBusiness) return;
    try {
      const { url } = await createBusinessOnboardingLink(activeBusiness.id);
      // Present Stripe Connect onboarding as an in-app SFSafariViewController
      // modal — slides up like the billing portal, doesn't launch full Safari.
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor:     S.color,
        toolbarColor:      '#ffffff',
        dismissButtonStyle:'close',
      });
      // Onboarding can take a few minutes server-side. Refresh the dashboard
      // when the sheet closes so payout_enabled flips to true if Stripe
      // approved the account.
      loadAll(activeBusiness);
    } catch (e: any) {
      Alert.alert('Stripe onboarding failed', e?.message ?? 'Try again later');
    }
  };

  const toggleAcceptWallet = async (value: boolean) => {
    if (!activeBusiness) return;
    if (value && !activeBusiness.payout_enabled) {
      return Alert.alert('Complete Stripe first', 'Connect your Stripe account before accepting wallet payments.');
    }
    await updateBusiness(activeBusiness.id, { accepts_wallet: value });
    setActiveBusiness({ ...activeBusiness, accepts_wallet: value });
  };

  const updateCashback = async (percent: number) => {
    if (!activeBusiness) return;
    await updateBusiness(activeBusiness.id, { cashback_percent: percent });
    setActiveBusiness({ ...activeBusiness, cashback_percent: percent });
  };

  const toggleAcceptsBookings = async (value: boolean) => {
    if (!activeBusiness) return;
    if (activeBusiness.subscription_tier !== 'premium') {
      return Alert.alert(
        'Premium feature',
        'In-app bookings are part of the Premium tier (£49.99/mo). Upgrade to enable.',
      );
    }
    if (value && bookServiceCount === 0) {
      return Alert.alert(
        'Add a service first',
        'Tap "Services" below and add at least one bookable thing before turning bookings on.',
      );
    }
    try {
      await setAcceptsBookings(activeBusiness.id, value);
      setActiveBusiness({ ...activeBusiness, accepts_bookings: value } as LocalBusiness);
      Haptics.selectionAsync();
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again.');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (businesses.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={[styles.center, { padding: spacing.xl, gap: 12 }]}>
          <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
            <FontAwesome5 name="store" size={28} color={S.color} solid />
          </View>
          <Text style={styles.emptyTitle}>You haven't listed a business yet</Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: S.color }]}
            onPress={() => router.replace('/local-business-register')}
          >
            <Text style={styles.primaryBtnText}>List your business</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!activeBusiness) return null;

  const stamps = program?.type === 'stamps';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Local</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{activeBusiness.name}</Text>
        <TouchableOpacity
          onPress={() => router.push({ pathname: '/local-business-register', params: { id: activeBusiness.id } })}
          hitSlop={12}
          style={{ width: 70, alignItems: 'flex-end' }}
        >
          <FontAwesome5 name="cog" size={16} color={S.color} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAll(activeBusiness); }} tintColor={S.color} />}
      >

        {/* Multiple business switcher */}
        {businesses.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bizSwitcher} contentContainerStyle={styles.bizSwitcherContent}>
            {businesses.map(b => (
              <TouchableOpacity
                key={b.id}
                style={[styles.bizSwitcherChip, b.id === activeBusiness.id && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => loadAll(b)}
              >
                <Text style={[styles.bizSwitcherText, b.id === activeBusiness.id && { color: '#fff' }]}>{b.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* ── Till code ── */}
        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>Till code · show to customer</Text>
          <Text style={styles.codeBig}>{code?.current_code ?? '— — — — — —'}</Text>
          <View style={styles.codeFooter}>
            <FontAwesome5 name="sync-alt" size={9} color={colors.textMuted} />
            <Text style={styles.codeFooterText}>Refreshes every 60 seconds</Text>
          </View>
        </View>

        {/* ── Backfill orphaned shifts banner ── */}
        {orphanedShiftCount > 0 && (
          <TouchableOpacity
            style={styles.backfillBanner}
            onPress={handleBackfillShifts}
            disabled={backfilling}
            activeOpacity={0.85}
          >
            <View style={styles.backfillIcon}>
              <FontAwesome5 name="link" size={11} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.backfillTitle}>
                {orphanedShiftCount} shift{orphanedShiftCount === 1 ? '' : 's'} not linked to a business
              </Text>
              <Text style={styles.backfillSub}>
                Tap to link {orphanedShiftCount === 1 ? 'it' : 'them all'} to {activeBusiness.name}.
              </Text>
            </View>
            {backfilling
              ? <ActivityIndicator size="small" color={S.color} />
              : <FontAwesome5 name="chevron-right" size={11} color={S.color} />}
          </TouchableOpacity>
        )}

        {/* ── Plan ── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5
                name={activeBusiness.subscription_tier === 'premium' ? 'crown' : activeBusiness.subscription_tier === 'pro' ? 'star' : 'circle'}
                size={13} color={S.color} solid
              />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.tierRow}>
                <Text style={styles.cardTitle}>
                  {isOnBoost(activeBusiness)
                    ? 'Pro · Boost'
                    : `${TIER_LABELS[activeBusiness.subscription_tier]} plan`}
                </Text>
                <Text style={styles.tierPrice}>{TIER_PRICE[activeBusiness.subscription_tier]}</Text>
              </View>
              {activeBusiness.subscription_until && (
                <Text style={styles.tierExpiry}>
                  {isOnBoost(activeBusiness)
                    ? `Expires ${new Date(activeBusiness.subscription_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
                    : `Renews ${new Date(activeBusiness.subscription_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                </Text>
              )}
            </View>
          </View>

          {/* Feature checklist — instantly clear what's unlocked vs locked */}
          <View style={styles.featureList}>
            {PLAN_FEATURES.map(f => {
              const unlocked = tierMeets(activeBusiness.subscription_tier as TierLevel, f.req);
              return (
                <View key={f.label} style={styles.featureRow}>
                  <FontAwesome5
                    name={unlocked ? 'check-circle' : 'lock'}
                    size={11}
                    color={unlocked ? '#10B981' : colors.textLight}
                    solid={unlocked}
                  />
                  <Text style={[styles.featureText, !unlocked && { color: colors.textMuted }]}>
                    {f.label}
                  </Text>
                  {!unlocked && (
                    <Text style={[styles.featureReq, { color: f.req === 'premium' ? PREMIUM_PURPLE : S.color }]}>
                      {f.req === 'premium' ? 'Premium' : 'Pro'}
                    </Text>
                  )}
                </View>
              );
            })}
          </View>

          {/* Single primary CTA based on current tier */}
          {activeBusiness.subscription_tier === 'free' && (
            <View style={{ gap: 6, marginTop: 14 }}>
              <TouchableOpacity
                style={[styles.upgradeBtn, { backgroundColor: S.color }, upgradeBusy && { opacity: 0.7 }]}
                onPress={() => startCheckout('pro')}
                disabled={upgradeBusy}
                activeOpacity={0.85}
              >
                {upgradeBusy ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <FontAwesome5 name="star" size={11} color="#fff" solid />
                    <Text style={styles.upgradeBtnText}>Upgrade to Pro · £19.99/mo</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => startCheckout('premium')} disabled={upgradeBusy} style={{ paddingVertical: 6 }}>
                <Text style={[styles.upgradeSecondary, { color: PREMIUM_PURPLE }]}>
                  Or unlock everything with Premium · £49.99/mo →
                </Text>
              </TouchableOpacity>

              {/* ── Boost — short-term Pro without a subscription ── */}
              {(boostPrices.one || boostPrices.two || boostPrices.three) && (
                <View style={styles.boostBlock}>
                  <View style={styles.boostHeader}>
                    <FontAwesome5 name="bolt" size={11} color={S.color} solid />
                    <Text style={styles.boostHeadline}>Or try Pro for a short time</Text>
                  </View>
                  <Text style={styles.boostHint}>
                    One-off payment. No subscription, no renewal — just unlocked for the duration.
                  </Text>
                  <View style={styles.boostOptionsRow}>
                    {[
                      { weeks: 1 as const, pence: boostPrices.one,   label: '1 week'  },
                      { weeks: 2 as const, pence: boostPrices.two,   label: '2 weeks' },
                      { weeks: 3 as const, pence: boostPrices.three, label: '3 weeks' },
                    ].filter(o => o.pence).map(o => {
                      const busy = boostBusy === o.weeks;
                      return (
                        <TouchableOpacity
                          key={o.weeks}
                          style={[styles.boostOption, busy && { opacity: 0.6 }]}
                          onPress={() => handleBoost(o.weeks)}
                          disabled={!!boostBusy}
                          activeOpacity={0.85}
                        >
                          {busy ? (
                            <ActivityIndicator color={S.color} size="small" />
                          ) : (
                            <>
                              <Text style={styles.boostOptionLabel}>{o.label}</Text>
                              <Text style={styles.boostOptionPrice}>£{(o.pence! / 100).toFixed(2)}</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}
            </View>
          )}
          {activeBusiness.subscription_tier === 'pro' && (
            <TouchableOpacity
              style={[styles.upgradeBtn, { backgroundColor: PREMIUM_PURPLE, marginTop: 14 }, upgradeBusy && { opacity: 0.7 }]}
              onPress={() => startCheckout('premium')}
              disabled={upgradeBusy}
              activeOpacity={0.85}
            >
              {upgradeBusy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <FontAwesome5 name="crown" size={11} color="#fff" solid />
                  <Text style={styles.upgradeBtnText}>Upgrade to Premium · £49.99/mo</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {activeBusiness.subscription_tier === 'premium' && (
            <View style={styles.allUnlocked}>
              <FontAwesome5 name="crown" size={13} color={PREMIUM_PURPLE} solid />
              <Text style={styles.allUnlockedText}>All features unlocked</Text>
            </View>
          )}

          {/* Cancellation pending banner — visible only when cancel_at_period_end is true */}
          {activeBusiness.subscription_cancel_at_period_end && activeBusiness.subscription_until && (
            <View style={styles.cancelBanner}>
              <FontAwesome5 name="exclamation-triangle" size={11} color="#92400E" solid />
              <Text style={styles.cancelBannerText}>
                Cancels on {new Date(activeBusiness.subscription_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.
                You'll keep access until then.
              </Text>
            </View>
          )}

          {/* Manage subscription — only when there's a paid plan to manage */}
          {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && (
            <TouchableOpacity
              style={styles.manageBtn}
              onPress={openBillingPortal}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="cog" size={11} color={colors.textPrimary} />
              <Text style={styles.manageBtnText}>
                Manage subscription · cancel · billing
              </Text>
              <FontAwesome5 name="external-link-alt" size={9} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* ── NFC tile — Pro+ only; hidden otherwise (Plan card handles awareness) ── */}
        {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
                <FontAwesome5 name="wifi" size={13} color={S.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>NFC tile</Text>
                <Text style={styles.cardSub}>
                  {activeBusiness.nfc_status === 'active' ? '✓ Active · customers can tap to stamp' :
                   activeBusiness.nfc_status === 'dispatched' ? 'Posted — stick it on the counter and tap it once with the app to activate' :
                   activeBusiness.nfc_status === 'requested' ? 'Requested · we\'ll ship within 3 working days' :
                   'Branded tap-to-stamp tile — included with your subscription'}
                </Text>
              </View>
            </View>

            {activeBusiness.nfc_token && (
              <View style={styles.nfcTokenRow}>
                <Text style={styles.nfcTokenLabel}>Your tile URL</Text>
                <Text style={styles.nfcTokenValue} selectable>
                  {NFC_TILE_URL_PREFIX}{activeBusiness.nfc_token}
                </Text>
              </View>
            )}

            {activeBusiness.nfc_status === 'none' && (
              <TouchableOpacity
                style={[styles.upgradeBtn, { backgroundColor: S.color }]}
                onPress={async () => {
                  if (!activeBusiness.lat || !activeBusiness.lng) {
                    return Alert.alert(
                      'Address needed',
                      'Pick your address from the dropdown when editing your business — the location is used to verify customers are on-site when they tap.',
                    );
                  }
                  try {
                    await requestNfcTile(activeBusiness.id);
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    Alert.alert(
                      'Tile requested!',
                      'We\'ll print your branded NFC tile and post it within 3 working days. You\'ll get a notification when it ships.',
                    );
                    loadAll(activeBusiness);
                  } catch (e: any) {
                    Alert.alert('Could not request', e.message ?? 'Try again');
                  }
                }}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="paper-plane" size={11} color="#fff" solid />
                <Text style={styles.upgradeBtnText}>Request my NFC tile</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Stripe Connect (for wallet) — Pro+ only ── */}
        {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5 name="wallet" size={13} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Accept Local Wallet</Text>
              <Text style={styles.cardSub}>
                {activeBusiness.payout_enabled
                  ? 'Stripe connected · ready for payouts'
                  : 'Connect Stripe to accept wallet payments'}
              </Text>
            </View>
            {activeBusiness.payout_enabled && (
              <Switch
                value={activeBusiness.accepts_wallet}
                onValueChange={toggleAcceptWallet}
                trackColor={{ false: colors.border, true: S.color }}
              />
            )}
          </View>

          {!activeBusiness.payout_enabled ? (
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: S.color, marginTop: 8 }]}
              onPress={handleConnectStripe}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="external-link-alt" size={11} color="#fff" />
              <Text style={styles.primaryBtnText}>Connect Stripe</Text>
            </TouchableOpacity>
          ) : activeBusiness.accepts_wallet ? (
            <View style={styles.cashbackRow}>
              <Text style={styles.cashbackLabel}>Cashback to customers</Text>
              <View style={styles.cashbackPills}>
                {[0, 2, 5, 10].map(pct => (
                  <TouchableOpacity
                    key={pct}
                    style={[styles.cashbackPill, activeBusiness.cashback_percent === pct && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => { Haptics.selectionAsync(); updateCashback(pct); }}
                  >
                    <Text style={[styles.cashbackPillText, activeBusiness.cashback_percent === pct && { color: '#fff' }]}>
                      {pct}%
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ) : null}
        </View>
        )}

        {/* ── Loyalty programme — Pro+ only ── */}
        {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5 name="stamp" size={13} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Loyalty programme</Text>
              <Text style={styles.cardSub}>
                {program
                  ? stamps
                    ? `${program.stamps_required} stamps · ${program.stamp_reward}`
                    : `${program.points_per_pound} points per £1`
                  : 'Not set up yet'}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.upgradeBtn, { backgroundColor: S.color, marginTop: 12 }]}
            onPress={() => setShowLoyaltyModal(true)}
            activeOpacity={0.85}
          >
            <FontAwesome5 name={program ? 'pen' : 'plus'} size={11} color="#fff" solid />
            <Text style={styles.upgradeBtnText}>
              {program ? 'Edit programme' : 'Set up loyalty programme'}
            </Text>
          </TouchableOpacity>
        </View>
        )}

        {/* ── Bookings — Premium only; hidden otherwise (Plan card handles awareness) ── */}
        {activeBusiness.subscription_tier === 'premium' && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
                <FontAwesome5 name="calendar-check" size={13} color={S.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Bookings</Text>
                <Text style={styles.cardSub}>
                  {activeBusiness.accepts_bookings
                    ? `${bookServiceCount} service${bookServiceCount === 1 ? '' : 's'} · live for booking`
                    : bookServiceCount > 0
                      ? `${bookServiceCount} service${bookServiceCount === 1 ? '' : 's'} ready · toggle on to go live`
                      : 'Let customers book slots in-app'}
                </Text>
              </View>
              <Switch
                value={activeBusiness.accepts_bookings ?? false}
                onValueChange={toggleAcceptsBookings}
                trackColor={{ false: colors.border, true: S.color }}
              />
            </View>

            <View style={styles.bookActionsRow}>
              <TouchableOpacity
                style={[styles.bookActionBtn, { borderColor: S.color }]}
                onPress={() => router.push({ pathname: '/local-book-services', params: { businessId: activeBusiness.id } })}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="concierge-bell" size={11} color={S.color} solid />
                <Text style={[styles.bookActionText, { color: S.color }]}>
                  Services {bookServiceCount > 0 ? `(${bookServiceCount})` : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bookActionBtn, { borderColor: S.color }]}
                onPress={() => router.push({ pathname: '/local-book-schedule', params: { businessId: activeBusiness.id } })}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="clock" size={11} color={S.color} solid />
                <Text style={[styles.bookActionText, { color: S.color }]}>Schedule</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bookActionBtn, { borderColor: S.color }]}
                onPress={() => router.push({ pathname: '/local-book-bookings', params: { businessId: activeBusiness.id } })}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="list" size={11} color={S.color} solid />
                <Text style={[styles.bookActionText, { color: S.color }]}>Bookings</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Offers — Pro+ only ── */}
        {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5 name="tags" size={13} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Offers</Text>
              <Text style={styles.cardSub}>{offers.filter(o => o.is_active).length} active</Text>
            </View>
            <TouchableOpacity
              style={[styles.cardIconBtn, { backgroundColor: S.color }]}
              onPress={() => router.push({ pathname: '/local-offer-new', params: { businessId: activeBusiness.id } })}
            >
              <FontAwesome5 name="plus" size={11} color="#fff" />
            </TouchableOpacity>
          </View>

          {offers.length > 0 && (
            <View style={{ gap: 8, marginTop: 12 }}>
              {offers.map(o => (
                <View key={o.id} style={[styles.offerLine, !o.is_active && { opacity: 0.5 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.offerLineTitle}>{o.title}</Text>
                    <Text style={styles.offerLineMeta}>
                      {formatOfferDiscount(o)} · {o.redemption_count} claim{o.redemption_count !== 1 ? 's' : ''}
                      {o.is_active ? ` · ${daysRemaining(o.valid_until)}d left` : ' · ended'}
                    </Text>
                  </View>
                  {o.is_active && (
                    <TouchableOpacity onPress={() => {
                      Alert.alert('End this offer?', 'It will no longer be visible to customers.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'End', style: 'destructive', onPress: async () => {
                          await deactivateOffer(o.id);
                          loadAll(activeBusiness);
                        }},
                      ]);
                    }}>
                      <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
        )}

        {/* ── Public profile link ── */}
        <TouchableOpacity
          style={styles.viewPublicBtn}
          onPress={() => router.push({ pathname: '/local-business-detail', params: { id: activeBusiness.id } })}
          activeOpacity={0.8}
        >
          <FontAwesome5 name="eye" size={11} color={S.color} />
          <Text style={[styles.viewPublicText, { color: S.color }]}>View public profile</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      <LoyaltyModal
        visible={showLoyaltyModal}
        program={program}
        businessId={activeBusiness.id}
        onClose={() => setShowLoyaltyModal(false)}
        onSaved={() => { setShowLoyaltyModal(false); loadAll(activeBusiness); }}
      />
    </SafeAreaView>
  );
}

// ── Loyalty editor modal ─────────────────────────────────────────────────────

function LoyaltyModal({
  visible, program, businessId, onClose, onSaved,
}: {
  visible: boolean;
  program: LoyaltyProgram | null;
  businessId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType]           = useState<LoyaltyType>('stamps');
  const [stamps, setStamps]       = useState('9');
  const [reward, setReward]       = useState('');
  const [pointsPer, setPointsPer] = useState('10');
  const [pointsFor, setPointsFor] = useState('100');
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    if (program) {
      setType(program.type);
      setStamps(String(program.stamps_required ?? 9));
      setReward(program.stamp_reward ?? '');
      setPointsPer(String(program.points_per_pound ?? 10));
      setPointsFor(String(program.points_for_pound ?? 100));
    }
  }, [program, visible]);

  const save = async () => {
    if (type === 'stamps') {
      if (!reward.trim()) return Alert.alert('Reward required', 'Describe what the customer gets.');
      const n = parseInt(stamps); if (!n || n < 2) return Alert.alert('Min 2 stamps', 'Try 5–10');
    } else {
      const pp = parseFloat(pointsPer); const pf = parseInt(pointsFor);
      if (!pp || pp <= 0 || !pf || pf <= 0) return Alert.alert('Invalid points config');
    }
    setSaving(true);
    try {
      await upsertLoyaltyProgram(businessId, {
        type,
        stamps_required: type === 'stamps' ? parseInt(stamps) : null,
        stamp_reward:    type === 'stamps' ? reward.trim() : null,
        points_per_pound: type === 'points' ? parseFloat(pointsPer) : null,
        points_for_pound: type === 'points' ? parseInt(pointsFor) : null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      Alert.alert('Save failed', e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.sheet}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.title}>Loyalty programme</Text>

          <View style={modalStyles.typeRow}>
            {(['stamps', 'points'] as const).map(t => (
              <TouchableOpacity
                key={t}
                style={[modalStyles.typeBtn, type === t && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => setType(t)}
              >
                <Text style={[modalStyles.typeText, type === t && { color: '#fff' }]}>
                  {t === 'stamps' ? 'Stamps' : 'Points'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {type === 'stamps' ? (
            <>
              <Text style={modalStyles.label}>Stamps to collect</Text>
              <TextInput
                style={modalStyles.input}
                value={stamps} onChangeText={setStamps}
                keyboardType="number-pad"
              />
              <Text style={modalStyles.label}>Reward customer gets</Text>
              <TextInput
                style={modalStyles.input}
                value={reward} onChangeText={setReward}
                placeholder="e.g. Free coffee of your choice"
                placeholderTextColor={colors.textLight}
              />
            </>
          ) : (
            <>
              <Text style={modalStyles.label}>Points earned per £1 spent</Text>
              <TextInput
                style={modalStyles.input}
                value={pointsPer} onChangeText={setPointsPer}
                keyboardType="decimal-pad"
              />
              <Text style={modalStyles.label}>Points needed for £1 off</Text>
              <TextInput
                style={modalStyles.input}
                value={pointsFor} onChangeText={setPointsFor}
                keyboardType="number-pad"
              />
            </>
          )}

          <View style={modalStyles.actions}>
            <TouchableOpacity onPress={onClose} style={modalStyles.cancelBtn}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[modalStyles.saveBtn, { backgroundColor: S.color }, saving && { opacity: 0.7 }]}
              onPress={save}
              disabled={saving}
            >
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={modalStyles.saveText}>Save</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  scroll: { flex: 1 },
  content:{ padding: spacing.md, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },

  bizSwitcher: { maxHeight: 44, marginBottom: 4 },
  bizSwitcherContent: { gap: 8, paddingRight: spacing.md },
  bizSwitcherChip: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border },
  bizSwitcherText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  // Code card
  codeCard: {
    backgroundColor: colors.navy, borderRadius: radius.xl,
    padding: spacing.lg, alignItems: 'center', gap: 8,
  },
  codeLabel: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  codeBig:   { color: S.color, fontSize: 56, fontWeight: '900', letterSpacing: 10, marginVertical: 4 },
  codeFooter:{ flexDirection: 'row', alignItems: 'center', gap: 6 },
  codeFooterText: { color: 'rgba(255,255,255,0.45)', fontSize: fontSize.xs, fontWeight: '600' },

  // Card
  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  cardHeader:{ flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardIcon:  { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  cardSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  cardIconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  tierRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tierPrice:  { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },
  tierExpiry: { fontSize: 10, color: colors.textLight, fontWeight: '600', marginTop: 2 },

  // Plan card feature checklist
  featureList: { gap: 8, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  featureRow:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  featureText: { flex: 1, fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600' },
  featureReq:  { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },
  upgradeSecondary: { fontSize: fontSize.xs, fontWeight: '800', textAlign: 'center' },

  // ── Boost ──
  boostBlock:        { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 },
  boostHeader:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  boostHeadline:     { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary },
  boostHint:         { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  boostOptionsRow:   { flexDirection: 'row', gap: 8, marginTop: 4 },
  boostOption:       { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, borderColor: S.color, backgroundColor: '#fff' },
  boostOptionLabel:  { fontSize: 11, fontWeight: '800', color: S.color, letterSpacing: 0.3 },
  boostOptionPrice:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginTop: 2 },
  allUnlocked: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, paddingVertical: 10, backgroundColor: PREMIUM_PURPLE + '14', borderRadius: radius.md },
  allUnlockedText: { fontSize: fontSize.sm, fontWeight: '800', color: PREMIUM_PURPLE },

  backfillBanner:   { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: S.color + '12', borderRadius: radius.lg, borderWidth: 1, borderColor: S.color + '40' },
  backfillIcon:     { width: 30, height: 30, borderRadius: 15, backgroundColor: S.color + '22', alignItems: 'center', justifyContent: 'center' },
  backfillTitle:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  backfillSub:      { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1, lineHeight: 16 },

  cancelBanner:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 10, backgroundColor: '#FEF3C7', borderRadius: radius.md, borderWidth: 1, borderColor: '#FCD34D' },
  cancelBannerText: { flex: 1, fontSize: fontSize.xs, color: '#92400E', fontWeight: '700', lineHeight: 17 },

  manageBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10, paddingVertical: 10, backgroundColor: colors.screenBackground, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  manageBtnText:    { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },

  upgradeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radius.md, marginTop: 12,
  },
  upgradeBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  nfcTokenRow: {
    marginTop: 12, padding: 10, backgroundColor: S.light, borderRadius: radius.md,
    gap: 4,
  },
  nfcTokenLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  nfcTokenValue: { fontSize: 11, color: colors.textPrimary, fontFamily: 'monospace', fontWeight: '600' },

  cashbackRow: { marginTop: 12, gap: 6 },
  cashbackLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  cashbackPills: { flexDirection: 'row', gap: 8 },
  cashbackPill: { flex: 1, paddingVertical: 8, alignItems: 'center', borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, backgroundColor: '#fff' },
  cashbackPillText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary },

  bookActionsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  bookActionBtn:  { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, backgroundColor: '#fff' },
  bookActionText: { fontSize: fontSize.xs, fontWeight: '800' },

  offerLine: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  offerLineTitle: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary },
  offerLineMeta:  { fontSize: 10, color: colors.textMuted, marginTop: 1 },

  viewPublicBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: S.light, borderRadius: radius.md },
  viewPublicText:{ fontSize: fontSize.xs, fontWeight: '800' },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radius.md,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  emptyIcon:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg, paddingBottom: 40, gap: 12 },
  handle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  title: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },

  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  typeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, backgroundColor: '#fff' },
  typeText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textMuted },

  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 4 },
  input: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm },

  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  cancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  cancelText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },
  saveBtn: { flex: 2, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center' },
  saveText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
