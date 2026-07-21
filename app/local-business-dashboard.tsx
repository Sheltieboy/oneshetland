/**
 * local-business-dashboard.tsx
 *
 * Owner view: rotating till code, loyalty program management,
 * offers, wallet onboarding, and quick stats.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Switch, Linking, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { useAlert } from '@/components/BrandedAlert';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NavRail } from '@/components/NavRail';
import { Sheet } from '@/components/ui/Sheet';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyBusinesses, updateBusiness,
  fetchLoyaltyProgram, upsertLoyaltyProgram,
  fetchBusinessOffers, deactivateOffer,
  fetchBusinessCode, refreshBusinessCode,
  createBusinessOnboardingLink, createBillingPortalLink,
  isOnBoost,
  requestNfcTile, NFC_TILE_URL_PREFIX,
  isBusinessFeatured, TIER_LABELS, TIER_PRICE,
  formatOfferDiscount, daysRemaining,
  fetchBusinessWalletReceipts,
  fetchBusinessAddons, toggleAddon,
  ADDON_META, PREMIUM_ADDON_KEYS, EXTRA_ADDON_MONTHLY_PENCE, countExtraPremiumAddons,
  normalizeTiers,
  type LocalBusiness, type LoyaltyProgram, type LocalOffer, type BusinessCode, type LoyaltyType, type RewardTier,
  type BusinessWalletReceipt, type BusinessAddon, type AddonKey,
} from '@/lib/local-api';
import DateTimePicker from '@react-native-community/datetimepicker';
import { track } from '@/lib/analytics';
import { setAcceptsBookings, fetchBusinessServices } from '@/lib/book-api';
import { fetchBusinessEvents, type OsEvent } from '@/lib/events-api';
import {
  fetchMyAlertAccess, requestAlertAccess,
  sendAlert, cancelAlert, fetchMyBusinessAlerts, activateAlertAccess,
  fetchScheduledAlerts,
  type PartnerAlert, type AlertAccess, type AlertType,
} from '@/lib/alerts-api';
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
  const { sidePadding, isTablet } = useAppLayout();

  const [businesses, setBusinesses] = useState<LocalBusiness[]>([]);
  const [activeBusiness, setActiveBusiness] = useState<LocalBusiness | null>(null);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [offers, setOffers]   = useState<LocalOffer[]>([]);
  const [code, setCode]       = useState<BusinessCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showLoyaltyModal, setShowLoyaltyModal] = useState(false);
  const [bookServiceCount, setBookServiceCount] = useState(0);
  const [savingPaymentToggle, setSavingPaymentToggle] = useState(false);
  const [savingPayoutToggle,  setSavingPayoutToggle]  = useState(false);
  const [walletReceipts, setWalletReceipts] = useState<BusinessWalletReceipt[]>([]);

  // Backfill state — count of this user's shifts that don't yet have a
  // business linked (posted_as_business_id IS NULL). If > 0, we offer to
  // link them all to the active business.
  const [orphanedShiftCount, setOrphanedShiftCount] = useState(0);
  const [backfilling,        setBackfilling]        = useState(false);

  const [addons, setAddons] = useState<BusinessAddon[]>([]);
  const [addonsBusy, setAddonsBusy] = useState<AddonKey | null>(null);
  const [bizEvents, setBizEvents] = useState<OsEvent[]>([]);

  // Urgent alert state
  const [alertAccess,      setAlertAccess]      = useState<AlertAccess | null>(null);
  const [bizAlerts,        setBizAlerts]        = useState<PartnerAlert[]>([]);
  const [scheduledAlerts,  setScheduledAlerts]  = useState<PartnerAlert[]>([]);
  const [alertMessage,     setAlertMessage]     = useState('');
  const [alertType,        setAlertType]        = useState<AlertType>('disruption');
  const [alertBusy,        setAlertBusy]        = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [sendLater,        setSendLater]        = useState(false);
  const [scheduledFor,     setScheduledFor]     = useState<Date | null>(null);
  const [showDatePicker,   setShowDatePicker]   = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customPickerDate, setCustomPickerDate] = useState<Date>(new Date());
  const [alertDuration,    setAlertDuration]    = useState<number | null>(2); // hours, null = no expiry

  // Collapsible cards — collapsed by default; the header still shows the key status.
  const [expanded, setExpanded] = useState<{ addons: boolean; pay: boolean; plan: boolean; nfc: boolean }>({ addons: false, pay: false, plan: false, nfc: false });
  const toggleCard = (key: 'addons' | 'pay' | 'plan' | 'nfc') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

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
    const [prog, ofs, cd, bookSvcs, orphanCount, receipts, addonRows, evRows, alertAcc, alertRows, schedRows] = await Promise.all([
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
        .then(({ count }) => count ?? 0, () => 0),
      target.accepts_wallet
        ? fetchBusinessWalletReceipts(target.id, 20).catch(() => [] as BusinessWalletReceipt[])
        : Promise.resolve([] as BusinessWalletReceipt[]),
      fetchBusinessAddons(target.id).catch(() => [] as BusinessAddon[]),
      fetchBusinessEvents(target.id).catch(() => [] as OsEvent[]),
      fetchMyAlertAccess(target.id).catch(() => null),
      fetchMyBusinessAlerts(target.id).catch(() => [] as PartnerAlert[]),
      fetchScheduledAlerts(target.id).catch(() => [] as PartnerAlert[]),
    ]);
    setProgram(prog);
    setOffers(ofs);
    setCode(cd);
    setBookServiceCount(bookSvcs.length);
    setOrphanedShiftCount(orphanCount as number);
    setWalletReceipts(receipts);
    setAddons(addonRows as BusinessAddon[]);
    setAlertAccess(alertAcc as AlertAccess | null);
    setBizAlerts((alertRows as PartnerAlert[]).filter(a => a.is_active));
    setScheduledAlerts(schedRows as PartnerAlert[]);
    // Show upcoming + ongoing events (starts in future, or ends in future)
    const now = new Date();
    setBizEvents(
      (evRows as OsEvent[])
        .filter(e => new Date(e.ends_at ?? e.starts_at) >= now)
        .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
        .slice(0, 5),
    );
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

  const { alert: brandedAlert } = useAlert();

  // Plan upgrades and short-term boosts are paid digital purchases. Their in-app
  // purchase paths (subscription checkout / proration / boost PaymentIntent) have
  // been removed for store compliance. The dashboard now shows the current plan
  // and which features are on, read-only.

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

  // Listing boost is a paid digital purchase; its in-app purchase path has been
  // removed for store compliance. The boost CTA is no longer rendered.

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
      brandedAlert({ title: 'Could not open billing', message: e?.message ?? 'Try again' });
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
      brandedAlert({ title: 'Stripe onboarding failed', message: e?.message ?? 'Try again later' });
    }
  };

  const toggleAcceptWallet = async (value: boolean) => {
    if (!activeBusiness) return;
    if (value && !activeBusiness.payout_enabled) {
      return brandedAlert({ title: 'Complete Stripe first', message: 'Connect your Stripe account before accepting wallet payments.' });
    }
    const prev = activeBusiness.accepts_wallet;
    setActiveBusiness({ ...activeBusiness, accepts_wallet: value });
    try {
      await updateBusiness(activeBusiness.id, { accepts_wallet: value });
    } catch (e: any) {
      setActiveBusiness({ ...activeBusiness, accepts_wallet: prev });
      brandedAlert({ title: 'Could not update', message: e?.message ?? 'Try again.' });
    }
  };

  const updateCashback = async (percent: number) => {
    if (!activeBusiness) return;
    const prev = activeBusiness.cashback_percent;
    setActiveBusiness({ ...activeBusiness, cashback_percent: percent });
    try {
      await updateBusiness(activeBusiness.id, { cashback_percent: percent });
    } catch (e: any) {
      setActiveBusiness({ ...activeBusiness, cashback_percent: prev });
      brandedAlert({ title: 'Could not update', message: e?.message ?? 'Try again.' });
    }
  };

  const toggleAcceptsBookings = async (value: boolean) => {
    if (!activeBusiness) return;
    if (activeBusiness.subscription_tier !== 'premium') {
      return brandedAlert({
        title: 'Premium feature',
        message: 'In-app bookings aren\'t enabled on your current plan.',
      });
    }
    if (value && bookServiceCount === 0) {
      return brandedAlert({
        title: 'Add a service first',
        message: 'Tap "Services" below and add at least one bookable thing before turning bookings on.',
      });
    }
    try {
      await setAcceptsBookings(activeBusiness.id, value);
      setActiveBusiness({ ...activeBusiness, accepts_bookings: value } as LocalBusiness);
      Haptics.selectionAsync();
    } catch (e: any) {
      brandedAlert({ title: 'Could not update', message: e?.message ?? 'Try again.' });
    }
  };

  const toggleBusinessPayment = async (value: boolean) => {
    if (!activeBusiness) return;
    setSavingPaymentToggle(true);
    try {
      await updateBusiness(activeBusiness.id, { use_business_payment: value } as any);
      setActiveBusiness({ ...activeBusiness, use_business_payment: value } as any);
      Haptics.selectionAsync();
    } catch (e: any) {
      brandedAlert({ title: 'Could not update', message: e?.message ?? 'Try again.' });
    } finally {
      setSavingPaymentToggle(false);
    }
  };

  const handleAddonToggle = async (key: AddonKey, enabled: boolean) => {
    if (!activeBusiness) return;
    const isPremium = (PREMIUM_ADDON_KEYS as readonly string[]).includes(key);
    // ENABLING a premium add-on is a paid digital purchase (it can add a paid
    // extra to the subscription). That in-app purchase path has been removed for
    // store compliance, so we show a neutral locked state instead of charging.
    // Disabling a premium add-on, and all standard/free add-on toggles, still work.
    if (isPremium && enabled) {
      brandedAlert({
        title: 'Premium feature',
        message: 'This add-on isn\'t enabled on your current plan.',
        icon: 'lock',
        accent: colors.textMuted,
        actions: [{ label: 'OK', style: 'primary' }],
      });
      return;
    }
    setAddonsBusy(key);
    try {
      await toggleAddon(activeBusiness.id, key, enabled);
      setAddons(prev => prev.map(a => a.addon_key === key ? { ...a, enabled } : a));
      // Keep accepts_bookings in sync so isBookableLive() stays correct.
      if (key === 'bookings') {
        if (enabled && bookServiceCount === 0) {
          brandedAlert({ title: 'Add a service first', message: 'Tap "Services" in the Bookings section and add at least one before going live.' });
          await toggleAddon(activeBusiness.id, 'bookings', false);
          setAddons(prev => prev.map(a => a.addon_key === 'bookings' ? { ...a, enabled: false } : a));
        } else {
          await setAcceptsBookings(activeBusiness.id, enabled);
          setActiveBusiness(prev => prev ? { ...prev, accepts_bookings: enabled } as LocalBusiness : prev);
        }
      }
      Haptics.selectionAsync();
    } catch (e: any) {
      brandedAlert({ title: 'Could not update add-on', message: e?.message ?? 'Try again.' });
    } finally {
      setAddonsBusy(null);
    }
  };

  const toggleBusinessPayout = async (value: boolean) => {
    if (!activeBusiness) return;
    setSavingPayoutToggle(true);
    try {
      await updateBusiness(activeBusiness.id, { use_business_payout: value } as any);
      setActiveBusiness({ ...activeBusiness, use_business_payout: value } as any);
      Haptics.selectionAsync();
    } catch (e: any) {
      brandedAlert({ title: 'Could not update', message: e?.message ?? 'Try again.' });
    } finally {
      setSavingPayoutToggle(false);
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
      <NavRail />
      <View style={{ flex: 1, paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 }}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
          hitSlop={12}
        >
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
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
        contentContainerStyle={[styles.content, { paddingHorizontal: Math.max(spacing.lg, sidePadding) }]}
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

        {/* ── Confirm a redemption (staff scan/verify) ── */}
        <TouchableOpacity
          style={styles.backfillBanner}
          onPress={() => router.push('/local-verify')}
          activeOpacity={0.85}
        >
          <View style={styles.backfillIcon}>
            <FontAwesome5 name="qrcode" size={11} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.backfillTitle}>Confirm a redemption</Text>
            <Text style={styles.backfillSub}>Scan or enter a customer’s code to redeem an offer, reward or pass.</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color={S.color} />
        </TouchableOpacity>

        {/* ── Analytics ── */}
        <TouchableOpacity
          style={styles.backfillBanner}
          onPress={() => router.push({ pathname: '/local-business-analytics', params: { businessId: activeBusiness.id } })}
          activeOpacity={0.85}
        >
          <View style={styles.backfillIcon}>
            <FontAwesome5 name="chart-line" size={11} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.backfillTitle}>Analytics</Text>
            <Text style={styles.backfillSub}>Views, engagement &amp; revenue for {activeBusiness.name}.</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color={S.color} />
        </TouchableOpacity>

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

        {/* ── Add-ons & features ── */}
        {(() => {
          const isPremium = activeBusiness.subscription_tier === 'premium';
          const enabledCount = addons.filter(a => a.enabled).length;
          const extraCount = countExtraPremiumAddons(addons);
          const premiumKeys = PREMIUM_ADDON_KEYS as readonly string[];
          const addonGroups: Array<{ label: string; keys: AddonKey[] }> = [
            { label: 'Premium add-ons', keys: ['bookings', 'services', 'events', 'membership', 'products'] },
            { label: 'Standard add-ons', keys: ['offers', 'stamps', 'enquiries', 'payments', 'featured'] },
          ];
          return (
            <View style={styles.card}>
              <TouchableOpacity style={styles.cardHeader} onPress={() => toggleCard('addons')} activeOpacity={0.7}>
                <View style={[styles.cardIcon, { backgroundColor: PREMIUM_PURPLE + '18' }]}>
                  <FontAwesome5 name="puzzle-piece" size={13} color={PREMIUM_PURPLE} solid />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Add-ons &amp; features</Text>
                  <Text style={styles.cardSub}>
                    {enabledCount} active · {isPremium ? `${extraCount} extra at £${(extraCount * EXTRA_ADDON_MONTHLY_PENCE / 100).toFixed(0)}/mo` : 'Premium unlocks more'}
                  </Text>
                </View>
                <FontAwesome5 name={expanded.addons ? 'chevron-up' : 'chevron-down'} size={13} color={colors.textMuted} />
              </TouchableOpacity>

              {expanded.addons && (
                <>
                  {!isPremium && (
                    <View style={styles.addonUpgradeBanner}>
                      <FontAwesome5 name="lock" size={12} color={colors.textMuted} solid />
                      <Text style={styles.addonUpgradeText}>
                        Bookings, Services, Events, Membership and Products are <Text style={{ fontWeight: '900' }}>premium features</Text>, not enabled on your current plan.
                      </Text>
                    </View>
                  )}
                  {isPremium && extraCount > 0 && (
                    <View style={[styles.addonUpgradeBanner, { backgroundColor: PREMIUM_PURPLE + '10', borderColor: PREMIUM_PURPLE + '30' }]}>
                      <FontAwesome5 name="info-circle" size={12} color={PREMIUM_PURPLE} />
                      <Text style={[styles.addonUpgradeText, { color: PREMIUM_PURPLE }]}>
                        1 premium add-on included · {extraCount} extra at £{(extraCount * EXTRA_ADDON_MONTHLY_PENCE / 100).toFixed(0)}/mo added to your subscription.
                      </Text>
                    </View>
                  )}

                  {addonGroups.map(group => (
                    <View key={group.label} style={styles.addonGroup}>
                      <Text style={styles.subSectionLabel}>{group.label}</Text>
                      {group.keys.map(key => {
                        const meta    = ADDON_META[key];
                        const addon   = addons.find(a => a.addon_key === key);
                        const on      = addon?.enabled ?? false;
                        const isPremiumKey = premiumKeys.includes(key);
                        // Enabling a premium add-on is a paid purchase (removed for
                        // store compliance). Lock premium add-ons that are currently
                        // off so they read as a locked feature; an already-on premium
                        // add-on stays toggleable so it can be turned off.
                        const locked  = isPremiumKey && !on;
                        const busy    = addonsBusy === key;
                        const enabledPremiumCount = addons.filter(a => a.enabled && premiumKeys.includes(a.addon_key)).length;
                        const isFirstPremium = on && premiumKeys.includes(key) &&
                          addons.filter(a => a.enabled && premiumKeys.includes(a.addon_key))[0]?.addon_key === key;
                        return (
                          <View key={key} style={styles.addonRow}>
                            <View style={[styles.addonIconWrap, { backgroundColor: locked ? colors.border : PREMIUM_PURPLE + '14' }]}>
                              <FontAwesome5 name={meta.icon} size={12} color={locked ? colors.textLight : PREMIUM_PURPLE} solid />
                            </View>
                            <View style={{ flex: 1, gap: 2 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Text style={[styles.addonLabel, locked && { color: colors.textLight }]}>{meta.label}</Text>
                                {premiumKeys.includes(key) && on && (
                                  <View style={[styles.addonBadge, { backgroundColor: isFirstPremium ? PREMIUM_PURPLE + '20' : '#FEF3C7' }]}>
                                    <Text style={[styles.addonBadgeText, { color: isFirstPremium ? PREMIUM_PURPLE : '#92400E' }]}>
                                      {isFirstPremium ? 'Included' : `+£${(EXTRA_ADDON_MONTHLY_PENCE / 100).toFixed(0)}/mo`}
                                    </Text>
                                  </View>
                                )}
                                {locked && (
                                  <View style={[styles.addonBadge, { backgroundColor: colors.border }]}>
                                    <Text style={[styles.addonBadgeText, { color: colors.textMuted }]}>Premium</Text>
                                  </View>
                                )}
                              </View>
                              <Text style={styles.addonDesc} numberOfLines={1}>{meta.description}</Text>
                            </View>
                            {busy
                              ? <ActivityIndicator size="small" color={PREMIUM_PURPLE} />
                              : <Switch
                                  value={on}
                                  onValueChange={v => handleAddonToggle(key, v)}
                                  disabled={locked}
                                  trackColor={{ false: colors.border, true: PREMIUM_PURPLE + '66' }}
                                  thumbColor={on ? PREMIUM_PURPLE : colors.textLight}
                                  ios_backgroundColor={colors.border}
                                />
                            }
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </>
              )}
            </View>
          );
        })()}

        {/* ── Plan, payments & payouts (merged) ── */}
        <View style={styles.card}>
          <TouchableOpacity style={styles.cardHeader} onPress={() => toggleCard('plan')} activeOpacity={0.7}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5 name="cog" size={13} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Plan, payments &amp; payouts</Text>
              <Text style={styles.cardSub}>
                {isOnBoost(activeBusiness) ? 'Pro · Boost' : `${TIER_LABELS[activeBusiness.subscription_tier]} plan`} · billing, payouts &amp; NFC
              </Text>
            </View>
            <FontAwesome5 name={expanded.plan ? 'chevron-up' : 'chevron-down'} size={13} color={colors.textMuted} />
          </TouchableOpacity>

          {expanded.plan && (<>
          <Text style={styles.subSectionLabel}>Payments &amp; payouts</Text>
          {/* Payment card row */}
          <View style={styles.payToggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.payToggleLabel}>Payment card</Text>
              <Text style={styles.payToggleSub}>
                {(activeBusiness as any).use_business_payment
                  ? (activeBusiness as any).has_business_payment_method
                    ? '✓ Business card set up'
                    : 'Business card — setup needed'
                  : 'Using your central OneShetland card'}
              </Text>
            </View>
            <Switch
              value={!!(activeBusiness as any).use_business_payment}
              onValueChange={toggleBusinessPayment}
              disabled={savingPaymentToggle}
              trackColor={{ false: colors.border, true: colors.jobs + '55' }}
              thumbColor={(activeBusiness as any).use_business_payment ? colors.jobs : '#fff'}
            />
          </View>

          {/* If business card is ON and not yet set up, show setup CTA */}
          {(activeBusiness as any).use_business_payment && !(activeBusiness as any).has_business_payment_method && (
            <TouchableOpacity
              style={[styles.paySetupBtn, { borderColor: colors.jobs }]}
              onPress={() => router.push({ pathname: '/payment-setup', params: { businessId: activeBusiness.id } })}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="credit-card" size={11} color={colors.jobs} />
              <Text style={[styles.paySetupBtnText, { color: colors.jobs }]}>Set up business card</Text>
            </TouchableOpacity>
          )}

          {/* Payout bank row */}
          <View style={[styles.payToggleRow, { borderBottomWidth: 0, marginTop: 4 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.payToggleLabel}>Payout bank account</Text>
              <Text style={styles.payToggleSub}>
                {(activeBusiness as any).use_business_payout
                  ? (activeBusiness as any).business_stripe_payouts_enabled
                    ? '✓ Business bank connected'
                    : (activeBusiness as any).business_stripe_onboarding_complete
                      ? 'Verification in progress'
                      : 'Business bank — setup needed'
                  : 'Using your central OneShetland bank'}
              </Text>
            </View>
            <Switch
              value={!!(activeBusiness as any).use_business_payout}
              onValueChange={toggleBusinessPayout}
              disabled={savingPayoutToggle}
              trackColor={{ false: colors.border, true: colors.jobs + '55' }}
              thumbColor={(activeBusiness as any).use_business_payout ? colors.jobs : '#fff'}
            />
          </View>

          {/* If business bank is ON and not yet connected, show Connect CTA */}
          {(activeBusiness as any).use_business_payout && !(activeBusiness as any).business_stripe_payouts_enabled && (
            <TouchableOpacity
              style={[styles.paySetupBtn, { borderColor: colors.jobs, marginTop: 4 }]}
              onPress={handleConnectStripe}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="university" size={11} color={colors.jobs} />
              <Text style={[styles.paySetupBtnText, { color: colors.jobs }]}>
                {(activeBusiness as any).business_stripe_onboarding_complete
                  ? 'Check verification status'
                  : 'Connect business bank account'}
              </Text>
            </TouchableOpacity>
          )}

          <Text style={styles.payToggleNote}>
            Toggle off to use your personal OneShetland payment method for this business.
            Each business can have its own independent setup.
          </Text>

          <View style={styles.subDivider} />
          <Text style={styles.subSectionLabel}>Your plan</Text>
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

          {/* Monthly breakdown — base + each extra premium add-on */}
          {activeBusiness.subscription_tier === 'premium' && (() => {
            const enabledPremium = addons.filter(a => a.enabled && (PREMIUM_ADDON_KEYS as readonly string[]).includes(a.addon_key));
            const extras = enabledPremium.slice(1);
            const totalPence = 4999 + extras.length * EXTRA_ADDON_MONTHLY_PENCE;
            const rowS = { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: 3 };
            return (
              <View style={{ marginTop: spacing.sm, backgroundColor: colors.offWhite, borderRadius: radius.md, padding: spacing.sm }}>
                <View style={rowS}>
                  <Text style={{ fontSize: fontSize.sm, color: colors.textMuted }}>Premium plan</Text>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: colors.navy }}>£49.99</Text>
                </View>
                {extras.map(a => (
                  <View key={a.addon_key} style={rowS}>
                    <Text style={{ fontSize: fontSize.sm, color: colors.textMuted }}>+ Add-on: {ADDON_META[a.addon_key].label}</Text>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: colors.navy }}>£{(EXTRA_ADDON_MONTHLY_PENCE / 100).toFixed(2)}</Text>
                  </View>
                ))}
                <View style={[rowS, { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4, paddingTop: 6 }]}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.navy }}>Total</Text>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.navy }}>£{(totalPence / 100).toFixed(2)}/mo</Text>
                </View>
                {extras.length === 0 && (
                  <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 4 }}>
                    Includes one premium add-on. Each additional add-on is £{(EXTRA_ADDON_MONTHLY_PENCE / 100).toFixed(0)}/mo.
                  </Text>
                )}
              </View>
            );
          })()}

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

          {/* In-app plan upgrades and boosts have been removed for store
              compliance. The feature checklist above shows, read-only, which
              features the current plan includes and which are locked. */}
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

          {/* ── NFC tile — Pro+ only ── */}
          {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && (<>
            <View style={styles.subDivider} />
            <Text style={styles.subSectionLabel}>NFC tile</Text>
            <Text style={styles.cardSub}>
              {activeBusiness.nfc_status === 'active' ? '✓ Active · customers can tap to stamp' :
               activeBusiness.nfc_status === 'dispatched' ? 'Posted — stick it on the counter and tap it once with the app to activate' :
               activeBusiness.nfc_status === 'requested' ? 'Requested · we\'ll ship within 3 working days' :
               'Branded tap-to-stamp tile — included with your subscription'}
            </Text>
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
                    return brandedAlert({
                      title: 'Address needed',
                      message: 'Pick your address from the dropdown when editing your business — the location is used to verify customers are on-site when they tap.',
                    });
                  }
                  try {
                    await requestNfcTile(activeBusiness.id);
                    track('nfc_tile_requested', { businessId: activeBusiness.id });
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    brandedAlert({
                      title: 'Tile requested!',
                      message: 'We\'ll print your branded NFC tile and post it within 3 working days. You\'ll get a notification when it ships.',
                    });
                    loadAll(activeBusiness);
                  } catch (e: any) {
                    brandedAlert({ title: 'Could not request', message: e.message ?? 'Try again' });
                  }
                }}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="paper-plane" size={11} color="#fff" solid />
                <Text style={styles.upgradeBtnText}>Request my NFC tile</Text>
              </TouchableOpacity>
            )}
          </>)}
          </>)}
        </View>

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

        {/* ── Wallet payments received — Pro+, only when wallet accepted ── */}
        {tierMeets(activeBusiness.subscription_tier as TierLevel, 'pro') && activeBusiness.accepts_wallet && (
          <WalletReceiptsCard receipts={walletReceipts} accentColor={S.color} />
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
                      ? `${bookServiceCount} service${bookServiceCount === 1 ? '' : 's'} ready · enable via Add-ons`
                      : 'Manage services, schedule and bookings'}
                </Text>
              </View>
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
              <TouchableOpacity
                style={[styles.bookActionBtn, { borderColor: S.color }]}
                onPress={() => router.push({ pathname: '/local-book-units', params: { businessId: activeBusiness.id } })}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="ticket-alt" size={11} color={S.color} solid />
                <Text style={[styles.bookActionText, { color: S.color }]}>Units</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Jobs — shown when the (free) jobs add-on is enabled ── */}
        {addons.find(a => a.addon_key === 'jobs')?.enabled && (
          <TouchableOpacity
            style={styles.card}
            onPress={() => router.push({ pathname: '/business-jobs', params: { businessId: activeBusiness.id } } as any)}
            activeOpacity={0.85}
          >
            <View style={styles.cardHeader}>
              <View style={[styles.cardIcon, { backgroundColor: SECTIONS.jobs.color + '18' }]}>
                <FontAwesome5 name="briefcase" size={13} color={SECTIONS.jobs.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Jobs</Text>
                <Text style={styles.cardSub}>Post roles, take applications, manage hiring — free</Text>
              </View>
              <View style={[styles.cardIconBtn, { backgroundColor: SECTIONS.jobs.color }]}>
                <FontAwesome5 name="chevron-right" size={11} color="#fff" />
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* ── Events — shown when events add-on is enabled ── */}
        {addons.find(a => a.addon_key === 'events')?.enabled && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIcon, { backgroundColor: SECTIONS.events.color + '18' }]}>
                <FontAwesome5 name="calendar-alt" size={13} color={SECTIONS.events.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Events</Text>
                <Text style={styles.cardSub}>
                  {bizEvents.length > 0
                    ? `${bizEvents.length} upcoming event${bizEvents.length !== 1 ? 's' : ''}`
                    : 'Create and manage events, sell tickets'}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.cardIconBtn, { backgroundColor: SECTIONS.events.color }]}
                onPress={() => router.push({ pathname: '/event-create', params: { businessId: activeBusiness.id } })}
              >
                <FontAwesome5 name="plus" size={11} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Upcoming events list */}
            {bizEvents.length > 0 && (
              <View style={{ gap: 8, marginBottom: 12 }}>
                {bizEvents.map(ev => {
                  const d = new Date(ev.starts_at);
                  const dateStr = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
                  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                  return (
                    <View key={ev.id} style={styles.evRow}>
                      <View style={[styles.evDatePill, { backgroundColor: SECTIONS.events.color + '18' }]}>
                        <Text style={[styles.evDateText, { color: SECTIONS.events.color }]}>{dateStr}</Text>
                        <Text style={[styles.evTimeText, { color: SECTIONS.events.color }]}>{timeStr}</Text>
                      </View>
                      <Text style={styles.evTitle} numberOfLines={1}>{ev.title}</Text>
                      <View style={styles.evActions}>
                        <TouchableOpacity
                          style={[styles.evBtn, { backgroundColor: SECTIONS.events.color + '18' }]}
                          onPress={() => router.push({ pathname: '/event-manage', params: { id: ev.id } })}
                          hitSlop={8}
                        >
                          <FontAwesome5 name="cog" size={11} color={SECTIONS.events.color} />
                        </TouchableOpacity>
                        {ev.has_tickets && (
                          <TouchableOpacity
                            style={[styles.evBtn, { backgroundColor: SECTIONS.events.color }]}
                            onPress={() => router.push({ pathname: '/event-scanner', params: { id: ev.id } })}
                            hitSlop={8}
                          >
                            <FontAwesome5 name="qrcode" size={11} color="#fff" />
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.bookActionsRow}>
              <TouchableOpacity
                style={[styles.bookActionBtn, { borderColor: SECTIONS.events.color }]}
                onPress={() => router.push({ pathname: '/event-create', params: { businessId: activeBusiness.id } })}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="plus" size={11} color={SECTIONS.events.color} />
                <Text style={[styles.bookActionText, { color: SECTIONS.events.color }]}>New event</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bookActionBtn, { borderColor: SECTIONS.events.color }]}
                onPress={() => router.push('/(tabs)/whats-on' as any)}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="calendar" size={11} color={SECTIONS.events.color} />
                <Text style={[styles.bookActionText, { color: SECTIONS.events.color }]}>What's On</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Schedule picker modal ── */}
        {/* ── Schedule presets modal ── */}
        {showDatePicker && (
          <Sheet
            visible={showDatePicker}
            onClose={() => { setShowDatePicker(false); setShowCustomPicker(false); }}
          >
                  <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginBottom: spacing.md }}>
                    {showCustomPicker ? 'Pick a time' : 'Schedule alert'}
                  </Text>

                  {!showCustomPicker ? (
                    <>
                      {[
                        { label: 'In 1 hour',     getDate: () => new Date(Date.now() + 3600000) },
                        { label: 'In 2 hours',    getDate: () => new Date(Date.now() + 7200000) },
                        { label: 'Tomorrow 9am',  getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
                        { label: 'Tomorrow noon', getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d; } },
                      ].map((p) => (
                        <TouchableOpacity
                          key={p.label}
                          style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
                          onPress={() => { setScheduledFor(p.getDate()); setShowDatePicker(false); }}
                        >
                          <Text style={{ fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' }}>{p.label}</Text>
                          <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 }}>
                            {p.getDate().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                          </Text>
                        </TouchableOpacity>
                      ))}

                      <TouchableOpacity
                        style={{ paddingVertical: 14 }}
                        onPress={() => {
                          const d = new Date();
                          d.setDate(d.getDate() + 1);
                          d.setHours(9, 0, 0, 0);
                          setCustomPickerDate(d);
                          setShowCustomPicker(true);
                        }}
                      >
                        <Text style={{ fontSize: fontSize.sm, color: colors.accent, fontWeight: '700' }}>Pick a custom time →</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <DateTimePicker
                        value={customPickerDate}
                        mode="datetime"
                        display="spinner"
                        minimumDate={new Date()}
                        onChange={(_e, date) => { if (date) setCustomPickerDate(date); }}
                        style={{ height: 180 }}
                      />
                      <View style={{ flexDirection: 'row', gap: 10, marginTop: spacing.md }}>
                        <TouchableOpacity
                          style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}
                          onPress={() => setShowCustomPicker(false)}
                        >
                          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted }}>Back</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={{ flex: 2, paddingVertical: 12, borderRadius: radius.md, backgroundColor: colors.navy, alignItems: 'center' }}
                          onPress={() => { setScheduledFor(customPickerDate); setShowDatePicker(false); setShowCustomPicker(false); }}
                        >
                          <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#fff' }}>
                            Confirm — {customPickerDate.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
          </Sheet>
        )}

        {/* ── Urgent Alerts ── */}
        <AlertsCard
          access={alertAccess}
          activeAlerts={bizAlerts}
          scheduledAlerts={scheduledAlerts}
          business={activeBusiness}
          alertMessage={alertMessage}
          alertType={alertType}
          alertBusy={alertBusy}
          requestingAccess={requestingAccess}
          sendLater={sendLater}
          scheduledFor={scheduledFor}
          alertDuration={alertDuration}
          onMessageChange={setAlertMessage}
          onTypeChange={setAlertType}
          onDurationChange={setAlertDuration}
          onToggleSendLater={() => {
            setSendLater(v => !v);
            if (!sendLater) setScheduledFor(null);
          }}
          onPickTime={() => setShowDatePicker(true)}
          onRequestAccess={async () => {
            setRequestingAccess(true);
            try {
              await requestAlertAccess(activeBusiness.id);
              await loadAll(activeBusiness);
            } catch (e: any) {
              brandedAlert({ title: 'Error', message: e.message ?? 'Could not send request' });
            } finally {
              setRequestingAccess(false);
            }
          }}
          onSendAlert={async () => {
            if (!alertMessage.trim()) return;
            if (sendLater && !scheduledFor) {
              brandedAlert({ title: 'Pick a time', message: 'Please choose when you want this alert to go out.' });
              return;
            }
            setAlertBusy(true);
            try {
              const expiresAt = alertDuration
                ? new Date(Date.now() + alertDuration * 3600 * 1000)
                : null;
              await sendAlert({
                businessId:   activeBusiness.id,
                businessName: activeBusiness.name,
                message:      alertMessage.trim(),
                type:         alertType,
                scheduledFor: sendLater ? scheduledFor : null,
                expiresAt,
              });
              setAlertMessage('');
              setSendLater(false);
              setScheduledFor(null);
              await loadAll(activeBusiness);
              if (sendLater && scheduledFor) {
                const when = scheduledFor.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
                brandedAlert({ title: 'Alert scheduled', message: `Your alert will go live on ${when}.` });
              } else {
                brandedAlert({ title: 'Alert sent', message: 'Your alert is now live across OneShetland.' });
              }
            } catch (e: any) {
              brandedAlert({ title: 'Error', message: e.message ?? 'Could not send alert' });
            } finally {
              setAlertBusy(false);
            }
          }}
          onCancelAlert={async (id: string) => {
            try {
              await cancelAlert(id);
              await loadAll(activeBusiness);
            } catch {}
          }}
          // The £10/mo urgent-alerts add-on is a paid digital purchase; its
          // in-app activation/payment path has been removed for store
          // compliance. Businesses that already have access keep composing and
          // sending alerts; the paid activation CTA is no longer shown.
        />

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
                      brandedAlert({
                        title: 'End this offer?',
                        message: 'It will no longer be visible to customers.',
                        actions: [
                          { label: 'Cancel', style: 'cancel' },
                          { label: 'End', style: 'destructive', onPress: async () => {
                            await deactivateOffer(o.id);
                            loadAll(activeBusiness);
                          }},
                        ],
                      });
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
      </View>

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

// ── Urgent Alerts card ────────────────────────────────────────────────────────

const ALERT_COLORS = {
  emergency:  { color: '#FF3B30', bg: '#FFF2F1', label: 'Emergency',  icon: 'exclamation-triangle' },
  disruption: { color: '#FF9500', bg: '#FFF8EC', label: 'Disruption', icon: 'exclamation-circle'   },
  info:       { color: '#0A84FF', bg: '#EEF5FF', label: 'Info',       icon: 'info-circle'           },
} as const;

const DURATION_OPTIONS: { label: string; hours: number | null }[] = [
  { label: '1h',      hours: 1    },
  { label: '2h',      hours: 2    },
  { label: '4h',      hours: 4    },
  { label: '8h',      hours: 8    },
  { label: '24h',     hours: 24   },
  { label: 'No expiry', hours: null },
];

function AlertsCard({
  access, activeAlerts, scheduledAlerts, business,
  alertMessage, alertType, alertBusy, requestingAccess,
  sendLater, scheduledFor, alertDuration,
  onMessageChange, onTypeChange,
  onToggleSendLater, onPickTime, onDurationChange,
  onRequestAccess, onSendAlert, onCancelAlert,
}: {
  access:             AlertAccess | null;
  activeAlerts:       PartnerAlert[];
  scheduledAlerts:    PartnerAlert[];
  business:           LocalBusiness;
  alertMessage:       string;
  alertType:          AlertType;
  alertBusy:          boolean;
  requestingAccess:   boolean;
  sendLater:          boolean;
  scheduledFor:       Date | null;
  alertDuration:      number | null;
  onMessageChange:    (v: string) => void;
  onTypeChange:       (t: AlertType) => void;
  onToggleSendLater:  () => void;
  onPickTime:         () => void;
  onDurationChange:   (hours: number | null) => void;
  onRequestAccess:    () => void;
  onSendAlert:        () => void;
  onCancelAlert:      (id: string) => void;
}) {
  const router = useRouter();
  const { alert } = useAlert();
  const ALERT_RED = '#FF3B30';

  return (
    <View style={[alertStyles.card, activeAlerts.length > 0 && alertStyles.cardActive]}>
      {/* Header */}
      <View style={alertStyles.header}>
        <View style={[alertStyles.iconWrap, { backgroundColor: ALERT_RED + '14' }]}>
          <FontAwesome5 name="broadcast-tower" size={14} color={ALERT_RED} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={alertStyles.title}>Urgent Alerts</Text>
          <Text style={alertStyles.sub}>
            {access?.status === 'active'
              ? activeAlerts.length > 0 ? `${activeAlerts.length} alert live` : 'Send real-time alerts to all users'
              : 'Broadcast urgent messages across OneShetland'}
          </Text>
        </View>
        {activeAlerts.length > 0 && (
          <View style={alertStyles.liveBadge}>
            <View style={alertStyles.liveDot} />
            <Text style={alertStyles.liveText}>LIVE</Text>
          </View>
        )}
      </View>

      {/* State: no access request yet */}
      {!access && (
        <View style={alertStyles.stateBox}>
          <Text style={alertStyles.stateDesc}>
            Instantly push urgent messages — ferry updates, event changes, road closures — to every OneShetland user. Requires approval from OneShetland.
          </Text>
          <TouchableOpacity
            style={[alertStyles.requestBtn, requestingAccess && { opacity: 0.6 }]}
            onPress={onRequestAccess}
            disabled={requestingAccess}
            activeOpacity={0.85}
          >
            {requestingAccess
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={alertStyles.requestBtnText}>Request access</Text>
            }
          </TouchableOpacity>
        </View>
      )}

      {/* State: pending approval */}
      {access?.status === 'requested' && (
        <View style={[alertStyles.stateBox, { backgroundColor: '#FFF8EC', borderColor: '#FF9500' + '30' }]}>
          <FontAwesome5 name="clock" size={18} color="#FF9500" />
          <Text style={[alertStyles.stateDesc, { textAlign: 'center' }]}>
            Your request is with OneShetland for review. You'll be notified once approved.
          </Text>
        </View>
      )}

      {/* State: approved but not yet active.
          The paid in-app activation CTA has been removed for store compliance —
          this now shows a neutral locked status only. */}
      {access?.status === 'approved' && (
        <View style={[alertStyles.stateBox, { backgroundColor: '#F0FBF3', borderColor: '#34C759' + '40' }]}>
          <FontAwesome5 name="check-circle" size={18} color="#34C759" />
          <Text style={[alertStyles.stateDesc, { textAlign: 'center' }]}>
            Approved. Urgent Alerts is a premium feature and isn&apos;t active on your account yet.
          </Text>
        </View>
      )}

      {/* State: active — compose + active alerts */}
      {access?.status === 'active' && (
        <View style={alertStyles.activeArea}>
          {/* Active alerts */}
          {activeAlerts.map(a => {
            const meta = ALERT_COLORS[a.type];
            return (
              <View key={a.id} style={[alertStyles.activeAlert, { backgroundColor: meta.bg, borderColor: meta.color + '40' }]}>
                <View style={[alertStyles.alertColorBar, { backgroundColor: meta.color }]} />
                <FontAwesome5 name={meta.icon} size={12} color={meta.color} solid style={{ marginRight: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[alertStyles.alertTypeBadge, { color: meta.color }]}>{meta.label.toUpperCase()}</Text>
                  <Text style={alertStyles.alertMsg} numberOfLines={2}>{a.message}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => alert({
                    title: 'Cancel alert?',
                    message: 'It will be removed from the app immediately.',
                    actions: [
                      { label: 'Keep', style: 'cancel' },
                      { label: 'Cancel alert', style: 'destructive', onPress: () => onCancelAlert(a.id) },
                    ],
                  })}
                  hitSlop={10}
                >
                  <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            );
          })}

          {/* View all link */}
          <TouchableOpacity
            style={alertStyles.viewAllRow}
            onPress={() => router.push({ pathname: '/business-alerts', params: { businessId: business.id, businessName: business.name } } as any)}
          >
            <Text style={alertStyles.viewAllText}>View all alerts & history</Text>
            <FontAwesome5 name="chevron-right" size={10} color={colors.accent} />
          </TouchableOpacity>

          {/* Compose */}
          <Text style={alertStyles.composeLabel}>Send a new alert</Text>

          {/* Type selector */}
          <View style={alertStyles.typeRow}>
            {(Object.entries(ALERT_COLORS) as [AlertType, typeof ALERT_COLORS[AlertType]][]).map(([key, meta]) => (
              <TouchableOpacity
                key={key}
                style={[
                  alertStyles.typeChip,
                  alertType === key && { backgroundColor: meta.color, borderColor: meta.color },
                ]}
                onPress={() => onTypeChange(key)}
                activeOpacity={0.8}
              >
                <FontAwesome5 name={meta.icon} size={9} color={alertType === key ? '#fff' : meta.color} solid />
                <Text style={[alertStyles.typeChipText, { color: alertType === key ? '#fff' : meta.color }]}>
                  {meta.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Scheduled alerts */}
          {scheduledAlerts.length > 0 && (
            <View style={alertStyles.scheduledSection}>
              <Text style={alertStyles.composeLabel}>SCHEDULED</Text>
              {scheduledAlerts.map(a => {
                const meta = ALERT_COLORS[a.type];
                const when = new Date(a.starts_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
                return (
                  <View key={a.id} style={[alertStyles.activeAlert, { backgroundColor: meta.bg, borderColor: meta.color + '40' }]}>
                    <View style={[alertStyles.alertColorBar, { backgroundColor: meta.color }]} />
                    <FontAwesome5 name="clock" size={12} color={meta.color} style={{ marginRight: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[alertStyles.alertTypeBadge, { color: meta.color }]}>SCHEDULED · {when}</Text>
                      <Text style={alertStyles.alertMsg} numberOfLines={2}>{a.message}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => alert({
                        title: 'Cancel scheduled alert?',
                        message: 'It will be deleted and never sent.',
                        actions: [
                          { label: 'Keep', style: 'cancel' },
                          { label: 'Delete', style: 'destructive', onPress: () => onCancelAlert(a.id) },
                        ],
                      })}
                      hitSlop={10}
                    >
                      <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          )}

          {/* Message input */}
          <TextInput
            style={alertStyles.messageInput}
            placeholder="What do people need to know right now?"
            placeholderTextColor={colors.textLight}
            value={alertMessage}
            onChangeText={onMessageChange}
            multiline
            maxLength={200}
          />
          <Text style={alertStyles.charCount}>{alertMessage.length}/200</Text>

          {/* Duration selector */}
          <View style={{ gap: 6 }}>
            <Text style={alertStyles.composeLabel}>LASTS FOR</Text>
            <View style={alertStyles.durationRow}>
              {DURATION_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={String(opt.hours)}
                  style={[alertStyles.durationChip, alertDuration === opt.hours && alertStyles.durationChipActive]}
                  onPress={() => onDurationChange(opt.hours)}
                  activeOpacity={0.7}
                >
                  <Text style={[alertStyles.durationChipText, alertDuration === opt.hours && alertStyles.durationChipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Send Later toggle */}
          <TouchableOpacity style={alertStyles.sendLaterRow} onPress={onToggleSendLater} activeOpacity={0.7}>
            <View style={{ flex: 1 }}>
              <Text style={alertStyles.sendLaterLabel}>Send later</Text>
              {sendLater && scheduledFor && (
                <TouchableOpacity onPress={onPickTime} hitSlop={6}>
                  <Text style={alertStyles.sendLaterTime}>
                    {scheduledFor.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · change
                  </Text>
                </TouchableOpacity>
              )}
              {sendLater && !scheduledFor && (
                <TouchableOpacity onPress={onPickTime} hitSlop={6}>
                  <Text style={[alertStyles.sendLaterTime, { color: colors.accent }]}>Tap to pick a time →</Text>
                </TouchableOpacity>
              )}
            </View>
            <Switch
              value={sendLater}
              onValueChange={onToggleSendLater}
              trackColor={{ true: colors.accent, false: colors.border }}
              thumbColor="#fff"
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              alertStyles.sendBtn,
              { backgroundColor: sendLater ? colors.navy : ALERT_COLORS[alertType].color },
              (!alertMessage.trim() || alertBusy || (sendLater && !scheduledFor)) && { opacity: 0.5 },
            ]}
            onPress={onSendAlert}
            disabled={!alertMessage.trim() || alertBusy || (sendLater && !scheduledFor)}
            activeOpacity={0.85}
          >
            {alertBusy
              ? <ActivityIndicator size="small" color="#fff" />
              : <>
                  <FontAwesome5 name={sendLater ? 'clock' : 'broadcast-tower'} size={12} color="#fff" solid />
                  <Text style={alertStyles.sendBtnText}>{sendLater ? 'Schedule alert' : 'Broadcast alert'}</Text>
                </>
            }
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const alertStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 14,
    marginBottom: 0,
  },
  cardActive: {
    borderColor: '#FF3B30' + '40',
    borderWidth: 1.5,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  iconWrap: {
    width: 38, height: 38, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  sub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#FF3B30' + '12',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full,
  },
  liveDot:  { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF3B30' },
  liveText: { fontSize: 9, fontWeight: '900', letterSpacing: 1, color: '#FF3B30' },

  stateBox: {
    backgroundColor: colors.screenBackground,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 12, alignItems: 'center',
  },
  stateDesc: {
    fontSize: fontSize.sm, color: colors.textSecondary,
    lineHeight: 19, textAlign: 'left',
  },
  requestBtn: {
    backgroundColor: colors.navy,
    borderRadius: radius.md, paddingVertical: 11, paddingHorizontal: 20,
    alignSelf: 'stretch', alignItems: 'center',
  },
  requestBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  activateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: '#34C759', borderRadius: radius.md,
    paddingVertical: 11, paddingHorizontal: 20, alignSelf: 'stretch', justifyContent: 'center',
  },
  activateBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  activeArea: { gap: 10 },
  activeAlert: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: radius.md, borderWidth: 1,
    paddingVertical: 10, paddingRight: 12, overflow: 'hidden',
  },
  alertColorBar:  { width: 4, alignSelf: 'stretch', minHeight: 36 },
  alertTypeBadge: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  alertMsg:       { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600', marginTop: 1 },

  composeLabel: {
    fontSize: fontSize.xs, fontWeight: '900', color: colors.textMuted,
    letterSpacing: 0.5, marginTop: 4,
  },
  typeRow: { flexDirection: 'row', gap: 8 },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
  },
  typeChipText: { fontSize: 11, fontWeight: '800' },

  messageInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, fontSize: fontSize.sm, color: colors.textPrimary,
    minHeight: 80, textAlignVertical: 'top',
    backgroundColor: colors.screenBackground,
  },
  charCount: { fontSize: 10, color: colors.textLight, textAlign: 'right', marginTop: -6 },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, borderRadius: radius.md,
  },
  sendBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

  scheduledSection: { gap: 8 },

  viewAllRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
    paddingVertical: 4,
  },
  viewAllText: { fontSize: fontSize.xs, color: colors.accent, fontWeight: '700' },

  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  durationChip: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
  },
  durationChipActive: { borderColor: colors.navy, backgroundColor: colors.navy },
  durationChipText:   { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  durationChipTextActive: { color: '#fff' },

  sendLaterRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: colors.screenBackground,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    gap: 12,
  },
  sendLaterLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  sendLaterTime:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});

// ── Wallet payments received card ────────────────────────────────────────────
//
// Shows the shop the money flowing in from wallet pay-at-till. Each row lists
// what the customer paid, what the platform retained, and what hit the shop's
// Connect balance. Legacy rows (pre-migration 033) show "—" for the fee/net
// because their fee_pence is NULL.

function WalletReceiptsCard({
  receipts, accentColor,
}: {
  receipts: BusinessWalletReceipt[];
  accentColor: string;
}) {
  // Week total = sum of net amounts for receipts in the last 7 days.
  // We sum gross when net is unknown (legacy rows) so the headline is
  // not artificially low — but flag it visually.
  const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent    = receipts.filter(r => new Date(r.created_at).getTime() >= weekStart);
  const weekNetTotal = recent.reduce(
    (sum, r) => sum + (r.net_pence ?? r.gross_pence),
    0,
  );
  const hasLegacy = recent.some(r => r.net_pence === null);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.cardIcon, { backgroundColor: accentColor + '18' }]}>
          <FontAwesome5 name="pound-sign" size={13} color={accentColor} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Wallet payments received</Text>
          <Text style={styles.cardSub}>
            {recent.length === 0
              ? 'No wallet payments in the last 7 days yet'
              : `£${(weekNetTotal / 100).toFixed(2)}${hasLegacy ? '+' : ''} this week · ${recent.length} payment${recent.length === 1 ? '' : 's'}`}
          </Text>
        </View>
      </View>

      {receipts.length > 0 && (
        <View style={styles.receiptList}>
          {receipts.slice(0, 10).map((r, i) => (
            <View
              key={r.id}
              style={[styles.receiptRow, i < Math.min(receipts.length, 10) - 1 && styles.receiptRowBorder]}
            >
              <View style={styles.receiptTopLine}>
                <Text style={styles.receiptWho} numberOfLines={1}>
                  {r.customer_first_name ?? 'Customer'}
                </Text>
                <Text style={styles.receiptTime}>
                  {formatReceiptTime(r.created_at)}
                </Text>
              </View>
              <View style={styles.receiptBreakdown}>
                <Text style={styles.receiptGross}>£{(r.gross_pence / 100).toFixed(2)} paid</Text>
                <Text style={styles.receiptSep}>·</Text>
                <Text style={[styles.receiptNet, { color: accentColor }]}>
                  {r.net_pence === null ? 'breakdown not recorded' : `£${(r.net_pence / 100).toFixed(2)} to you`}
                </Text>
                {r.fee_pence !== null && (
                  <>
                    <Text style={styles.receiptSep}>·</Text>
                    <Text style={styles.receiptFee}>£{(r.fee_pence / 100).toFixed(2)} fee</Text>
                  </>
                )}
                {r.cashback_pence !== null && r.cashback_pence > 0 && (
                  <>
                    <Text style={styles.receiptSep}>·</Text>
                    <Text style={styles.receiptCashback}>£{(r.cashback_pence / 100).toFixed(2)} cashback</Text>
                  </>
                )}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function formatReceiptTime(iso: string): string {
  const d   = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth() &&
    d.getDate()     === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth()    === yesterday.getMonth() &&
    d.getDate()     === yesterday.getDate();
  if (isYesterday) {
    return 'Yesterday ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
  // Optional extra reward-ladder rungs above the base reward.
  const [extraTiers, setExtraTiers] = useState<RewardTier[]>([]);
  const [pointsPer, setPointsPer] = useState('10');
  const [pointsFor, setPointsFor] = useState('100');
  const [saving, setSaving]       = useState(false);
  const { alert } = useAlert();

  useEffect(() => {
    if (program) {
      setType(program.type);
      const tiers = normalizeTiers(program.reward_tiers);
      if (tiers.length > 1) {
        setStamps(String(tiers[0].stamps));
        setReward(tiers[0].reward);
        setExtraTiers(tiers.slice(1));
      } else {
        setStamps(String(program.stamps_required ?? 9));
        setReward(program.stamp_reward ?? '');
        setExtraTiers([]);
      }
      setPointsPer(String(program.points_per_pound ?? 10));
      setPointsFor(String(program.points_for_pound ?? 100));
    }
  }, [program, visible]);

  const save = async () => {
    let tiers: RewardTier[] = [];
    if (type === 'stamps') {
      if (!reward.trim()) return alert({ title: 'Reward required', message: 'Describe what the customer gets.' });
      const n = parseInt(stamps); if (!n || n < 2) return alert({ title: 'Min 2 stamps', message: 'Try 5–10' });
      tiers = normalizeTiers([{ stamps: n, reward: reward.trim() }, ...extraTiers]);
      if (extraTiers.length > 0 && tiers.length !== extraTiers.length + 1) {
        return alert({ title: 'Check your reward tiers', message: 'Each tier needs a different stamp count and a reward.' });
      }
    } else {
      const pp = parseFloat(pointsPer); const pf = parseInt(pointsFor);
      if (!pp || pp <= 0 || !pf || pf <= 0) return alert({ title: 'Invalid points config' });
    }
    const ladder = type === 'stamps' && tiers.length > 1;
    setSaving(true);
    try {
      await upsertLoyaltyProgram(businessId, {
        type,
        // Headline stamps/reward = the top rung, so legacy readers still show something.
        stamps_required: type === 'stamps' ? (ladder ? tiers[tiers.length - 1].stamps : parseInt(stamps)) : null,
        stamp_reward:    type === 'stamps' ? (ladder ? tiers[tiers.length - 1].reward : reward.trim()) : null,
        reward_tiers:    ladder ? tiers : null,
        points_per_pound: type === 'points' ? parseFloat(pointsPer) : null,
        points_for_pound: type === 'points' ? parseInt(pointsFor) : null,
      });
      track('loyalty_program_created', { businessId });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      alert({ title: 'Save failed', message: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Loyalty programme">
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

              {/* Reward ladder — optional extra rungs at higher stamp counts. */}
              {extraTiers.map((t, i) => (
                <View key={i} style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={modalStyles.label}>Reward {i + 2} — at how many stamps</Text>
                    <TouchableOpacity onPress={() => setExtraTiers(prev => prev.filter((_, j) => j !== i))}>
                      <FontAwesome5 name="times-circle" size={16} color={colors.textLight} />
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={modalStyles.input}
                    value={t.stamps ? String(t.stamps) : ''}
                    onChangeText={v => setExtraTiers(prev => prev.map((x, j) => j === i ? { ...x, stamps: parseInt(v) || 0 } : x))}
                    keyboardType="number-pad"
                    placeholder={`e.g. ${(parseInt(stamps) || 5) * (i + 2)}`}
                    placeholderTextColor={colors.textLight}
                  />
                  <Text style={modalStyles.label}>What they get</Text>
                  <TextInput
                    style={modalStyles.input}
                    value={t.reward}
                    onChangeText={v => setExtraTiers(prev => prev.map((x, j) => j === i ? { ...x, reward: v } : x))}
                    placeholder="e.g. Free lunch"
                    placeholderTextColor={colors.textLight}
                  />
                </View>
              ))}
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.md }}
                onPress={() => setExtraTiers(prev => [...prev, { stamps: 0, reward: '' }])}
              >
                <FontAwesome5 name="plus-circle" size={14} color={S.color} solid />
                <Text style={{ color: S.color, fontWeight: '800', fontSize: fontSize.sm }}>Add another reward tier</Text>
              </TouchableOpacity>
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
    </Sheet>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
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

  // Merged-card sub-sections
  subSectionLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  subDivider:      { height: 1, backgroundColor: colors.border, marginTop: 16, marginBottom: 14 },

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

  // Payments & Payouts section
  payToggleRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  payToggleLabel:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  payToggleSub:     { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  paySetupBtn:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1.5, alignSelf: 'flex-start', marginTop: 6 },
  paySetupBtnText:  { fontSize: fontSize.xs, fontWeight: '800' },
  payToggleNote:    { fontSize: fontSize.xs, color: colors.textLight, lineHeight: 16, marginTop: 10 },

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

  // Wallet receipts list
  receiptList:       { marginTop: 12 },
  receiptRow:        { paddingVertical: 10, gap: 4 },
  receiptRowBorder:  { borderBottomWidth: 1, borderBottomColor: colors.border },
  receiptTopLine:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  receiptWho:        { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  receiptTime:       { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  receiptBreakdown:  { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  receiptGross:      { fontSize: fontSize.xs, color: colors.textMuted },
  receiptNet:        { fontSize: fontSize.xs, fontWeight: '800' },
  receiptFee:        { fontSize: fontSize.xs, color: colors.textLight },
  receiptCashback:   { fontSize: fontSize.xs, color: colors.textLight },
  receiptSep:        { fontSize: fontSize.xs, color: colors.textLight },

  // 2×2 grid — four buttons don't fit on one row without the labels overflowing the borders
  bookActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  bookActionBtn:  { flexGrow: 1, flexBasis: '47%', minWidth: 130, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 8, borderRadius: radius.md, borderWidth: 1.5, backgroundColor: '#fff' },
  bookActionText: { fontSize: fontSize.xs, fontWeight: '800' },
  evRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  evDatePill:  { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, minWidth: 72, alignItems: 'center' },
  evDateText:  { fontSize: 10, fontWeight: '800' },
  evTimeText:  { fontSize: 9, fontWeight: '600', opacity: 0.8 },
  evTitle:     { flex: 1, fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },
  evActions:   { flexDirection: 'row', gap: 6 },
  evBtn:       { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },

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

  // Add-ons card
  addonGroup:       { marginTop: 14, gap: 2 },
  addonRow:         { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  addonIconWrap:    { width: 30, height: 30, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  addonLabel:       { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary },
  addonDesc:        { fontSize: 10, color: colors.textMuted, lineHeight: 14 },
  addonBadge:       { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  addonBadgeText:   { fontSize: 9, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.4 },
  addonUpgradeBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 10, padding: 10,
    backgroundColor: '#F3F0FF', borderRadius: radius.md, borderWidth: 1, borderColor: PREMIUM_PURPLE + '25',
  },
  addonUpgradeText: { flex: 1, fontSize: fontSize.xs, color: colors.textPrimary, lineHeight: 17 },
});

const modalStyles = StyleSheet.create({
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
