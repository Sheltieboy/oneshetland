/**
 * local-business-dashboard.tsx
 *
 * Owner view: rotating till code, loyalty program management,
 * offers, wallet onboarding, and quick stats.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Switch, Linking, RefreshControl, Alert, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { useAlert } from '@/components/BrandedAlert';
import { CommercialTermsGate } from '@/components/CommercialTermsGate';
import { fetchCommercialTermsStatus } from '@/lib/commercial-terms';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NavRail } from '@/components/NavRail';
import { Sheet } from '@/components/ui/Sheet';
import { SECTIONS } from '@/constants/sections';
import { NO_ENTITLEMENT, type Effective } from '@/lib/entitlement';
import { fetchBusinessHome, type BusinessHome } from '@/lib/business-home';
import { businessOutcomes, type Outcome } from '@/lib/business-outcomes';
import { nextAction, hasOperationalAttention } from '@/lib/business-next-action';
import { availabilityIsFresh } from '@/constants/trades';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyBusinesses, fetchBusinessPrivate, updateBusiness,
  fetchLoyaltyProgram, upsertLoyaltyProgram,
  fetchBusinessOffers, deactivateOffer,
  fetchBusinessCode, refreshBusinessCode,
  createBusinessOnboardingLink, createBillingPortalLink,
  isOnBoost,
  requestNfcTile, NFC_TILE_URL_PREFIX,
  isBusinessFeatured, TIER_LABELS, TIER_PRICE,
  fetchBusinessWalletReceipts,
  normalizeTiers,
  type LocalBusiness, type LoyaltyProgram, type LocalOffer, type BusinessCode, type LoyaltyType, type RewardTier,
  type BusinessWalletReceipt,
} from '@/lib/local-api';
import DateTimePicker from '@react-native-community/datetimepicker';
import { track } from '@/lib/analytics';
import { setAcceptsBookings, fetchBusinessServices } from '@/lib/book-api';
import { fetchBusinessEvents, type OsEvent } from '@/lib/events-api';
import {
  fetchMyAlertAccess, requestAlertAccess,
  sendAlert, cancelAlert, fetchMyBusinessAlerts, acceptAlertPolicy,
  fetchScheduledAlerts,
  type PartnerAlert, type AlertAccess, type AlertType,
} from '@/lib/alerts-api';
import { supabase } from '@/lib/supabase';

const S = SECTIONS.local;

/**
 * One owner outcome, compact and thumb-friendly.
 *
 * A status sentence and a dot, above whatever detailed card already exists for
 * that outcome. Two-state on purpose: green means live to customers, grey means
 * everything else — including perfectly finished states like "not selling on
 * OneShetland". Amber would turn every unused capability into a warning, and
 * only NEEDS YOU is allowed to feel urgent.
 */
function OutcomeCard({ outcome, accent, fact, actions, children }: {
  outcome?: Outcome;
  accent: string;
  /** One supporting fact, when there is a useful one. */
  fact?: string | null;
  /** Compact text destinations. The managers live behind these, not in here. */
  actions?: { label: string; onPress: () => void }[];
  /** Anything that must stay operable from Home — a switch, a withdrawal. */
  children?: React.ReactNode;
}) {
  if (!outcome) return null;
  return (
    <View style={styles.outcomeCard}>
      <View style={styles.outcomeHead}>
        <View style={[styles.outcomeDot, { backgroundColor: outcome.tone === 'positive' ? '#16A34A' : '#C3CCD6' }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.outcomeTitle}>{outcome.title}</Text>
          <Text style={styles.outcomeStatus}>{outcome.status}{fact ? ` · ${fact}` : ''}</Text>
        </View>
      </View>
      {children}
      {!!actions?.length && (
        <View style={styles.outcomeActions}>
          {actions.map((a) => (
            <TouchableOpacity key={a.label} onPress={a.onPress} hitSlop={8} activeOpacity={0.7}>
              <Text style={[styles.outcomeAction, { color: accent }]}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// Tier helpers — single source of truth for "does this user's plan include X?"
type TierLevel = 'free' | 'pro' | 'premium';
// No local tierMeets any more. Comparing the stored subscription_tier is how
// this screen came to refuse Bookings to the Pro customers paying for it, so
// the helper is gone rather than left lying about for the next person.
// Entitlement comes from lib/entitlement.ts, which asks the server.

const PREMIUM_PURPLE = '#A855F7';

// Feature list used by the Plan card's checklist
const PLAN_FEATURES: { label: string; req: TierLevel }[] = [
  { label: 'Directory listing',      req: 'free'    },
  { label: 'Loyalty programme',      req: 'pro'     },
  { label: 'Time-limited offers',    req: 'pro'     },
  { label: 'Local Wallet payments',  req: 'pro'     },
  { label: 'NFC tap-to-stamp tile',  req: 'pro'     },
  { label: 'In-app bookings',        req: 'pro'     },
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
  /**
   * What the plan actually allows, from the server. Every paid action on this
   * screen asks this rather than subscription_tier, which only records what was
   * bought and not whether it is still in date.
   */
  const [eff, setEff] = useState<Effective>(NO_ENTITLEMENT);
  /** Attention, the week and the five outcome states — all derived, none stored. */
  const [home, setHome] = useState<BusinessHome | null>(null);
  const [savingPaymentToggle, setSavingPaymentToggle] = useState(false);
  const [savingPayoutToggle,  setSavingPayoutToggle]  = useState(false);
  const [walletReceipts, setWalletReceipts] = useState<BusinessWalletReceipt[]>([]);

  // Backfill state — count of this user's shifts that don't yet have a
  // business linked (posted_as_business_id IS NULL). If > 0, we offer to
  // link them all to the active business.
  const [orphanedShiftCount, setOrphanedShiftCount] = useState(0);
  const [backfilling,        setBackfilling]        = useState(false);

  const [bizEvents, setBizEvents] = useState<OsEvent[]>([]);

  // Urgent alert state
  const [alertAccess,      setAlertAccess]      = useState<AlertAccess | null>(null);
  const [bizAlerts,        setBizAlerts]        = useState<PartnerAlert[]>([]);

  // Collapsible cards — collapsed by default; the header still shows the key status.
  const [expanded, setExpanded] = useState<{ pay: boolean; plan: boolean; nfc: boolean; wallet: boolean }>({ pay: false, plan: false, nfc: false, wallet: false });
  const toggleCard = (key: 'pay' | 'plan' | 'nfc' | 'wallet') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const codeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAll = useCallback(async (biz?: LocalBusiness) => {
    if (!profile) return;
    const bizList = await fetchMyBusinesses(profile.id);
    // The NFC token, the Stripe status and the payment flags are no longer part
    // of the row anyone can select. They come back per business from an RPC
    // that checks ownership.
    const withPrivate = await Promise.all(
      bizList.map(async (b) => ({ ...b, ...(await fetchBusinessPrivate(b.id)) })),
    );
    setBusinesses(withPrivate);
    const target = biz ?? bizList[0];
    setActiveBusiness(target ?? null);
    if (!target) {
      setLoading(false);
      return;
    }
    const [prog, ofs, cd, bookSvcs, orphanCount, receipts, evRows, alertAcc, alertRows, homeData] = await Promise.all([
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
      // Always fetched. Receipts are the business's own record of money it has
      // taken; switching Wallet off, or a plan lapsing, does not un-take it.
      fetchBusinessWalletReceipts(target.id, 20).catch(() => [] as BusinessWalletReceipt[]),
      fetchBusinessEvents(target.id).catch(() => [] as OsEvent[]),
      fetchMyAlertAccess(target.id).catch(() => null),
      fetchMyBusinessAlerts(target.id).catch(() => [] as PartnerAlert[]),
      fetchBusinessHome(target.id, profile!.id,
        target as { trade_availability?: string | null; trade_availability_set_at?: string | null },
        (setAt) => !availabilityIsFresh(setAt)).catch(() => null),
    ]);
    setProgram(prog);
    setOffers(ofs);
    setCode(cd);
    setBookServiceCount(bookSvcs.length);
    // One question, one answer. fetchBusinessHome already asked the server what
    // this plan allows; asking again beside it was two identical RPC pairs for
    // the same business. Unreadable still means not entitled, exactly as before.
    const home = homeData as BusinessHome | null;
    setEff(home?.effective ?? NO_ENTITLEMENT);
    setHome(home);
    setOrphanedShiftCount(orphanCount as number);
    setWalletReceipts(receipts);
    setAlertAccess(alertAcc as AlertAccess | null);
    setBizAlerts((alertRows as PartnerAlert[]).filter(a => a.is_active));
    /* The one reading of "an upcoming event", matching the count in
       lib/business-home.ts exactly: published, not hidden, and still to come.
       This used to filter on the date alone, so a CANCELLED, HIDDEN event was
       listed here as upcoming while the outcome above it — correctly — said
       there were none. Two answers to one question, and the wrong one was the
       one with a date on it. */
    const now = new Date();
    setBizEvents(
      (evRows as OsEvent[])
        .filter(e => e.status === 'published' && !e.is_hidden && new Date(e.starts_at) > now)
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

  /**
   * ── The commercial controls inside an otherwise open dashboard ───────────
   *
   * This screen is deliberately NOT gated: names, hours, photos, analytics,
   * alerts, jobs and the rest are ordinary Directory management, and a business
   * that never sells anything is entitled to all of it.
   *
   * Two controls on it are not that. Choosing where money is paid, and opening
   * Stripe onboarding to arrange it, are the business acting as a business — so
   * the gate is on those ACTIONS rather than on the screen.
   *
   * Fails closed: the action proceeds only on a known, accepted status read
   * from the server. A status we could not read is not permission, and the
   * acceptance surface is shown instead. Merely rendering the dashboard, or the
   * gate, calls nothing at Stripe.
   */
  const [termsGateFor, setTermsGateFor] = useState<string | null>(null);

  const requireCommercialTerms = useCallback(async (feature: string): Promise<boolean> => {
    if (!activeBusiness) return false;
    const status = await fetchCommercialTermsStatus(activeBusiness.id);
    if (status.known && status.accepted) return true;
    setTermsGateFor(feature);
    return false;
  }, [activeBusiness]);

  const handleConnectStripe = async () => {
    if (!activeBusiness) return;
    // Before the account link exists, not after.
    if (!(await requireCommercialTerms('Business bank account'))) return;
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
    // Switching OFF is always allowed. Switching ON is the paid boundary, and
    // is what the server refuses too.
    if (value && !eff.pro) {
      return brandedAlert({
        title: 'Wallet payments need Pro',
        message: 'Your settings are saved. Switch Wallet on once your plan is active.',
      });
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

  /**
   * Stop a running loyalty programme. Reduction only, and offered whatever the
   * plan says: the server permits exactly this without Pro. It changes the
   * programme's own state and nothing else — customer cards, stamps, points and
   * history are not the shop's to clear.
   */
  /* ── The spine ───────────────────────────────────────────────────────────
     Derived on every load from lib/business-outcomes.ts — the same file the
     web Home uses, copied and pinned. Nothing here is stored. */
  const outcomes: Outcome[] = home
    ? businessOutcomes(
        { ...(activeBusiness as unknown as Record<string, unknown>), id: activeBusiness?.id ?? '' } as never,
        home.outcomes, '',
      )
    : [];
  const attention = home?.attention ?? [];
  /* NEXT defers entirely to what is waiting: suggesting a description while
     four customers wait would be insulting, and printing the same thing twice
     in two voices teaches people to ignore both. */
  const next = home && !hasOperationalAttention({
    orders: { length: attention.some(a => a.key === 'orders') ? 1 : 0 },
    bookings: { length: attention.some(a => a.key === 'bookings') ? 1 : 0 },
    leads: { length: attention.some(a => a.key === 'leads') ? 1 : 0 },
    needs: { jobApplications: attention.some(a => a.key === 'applications') ? 1 : 0 },
    isTrade: attention.some(a => a.key === 'availability'),
    tradeAvailability: attention.some(a => a.key === 'availability') ? 'stale' : null,
    tradeAvailabilitySetAt: null,
  })
    ? nextAction(
        { orders: { length: 0 }, bookings: { length: 0 }, leads: { length: 0 },
          needs: { jobApplications: 0 }, isTrade: false,
          tradeAvailability: null, tradeAvailabilitySetAt: null },
        (activeBusiness ?? {}) as never, '',
      )
    : null;

  /* ── Discovery ───────────────────────────────────────────────────────────
     A capability nobody has ever touched is not unfinished work sitting in the
     owner's way; it is something OneShetland can do that they may not know
     about. So `available` — the canonical never-configured state — moves out of
     the working area and into a quiet shelf, and anything with real
     configuration or history behind it stays where the work is.

     `unknown` is deliberately NOT discovery: a read we could not make is not
     proof that nothing exists.

     And the shelf waits. While the listing is still incomplete the owner's job
     is to be findable, and inviting them to build a loyalty card instead would
     be the product talking over them. */
  const DISCOVERABLE = [1, 2, 3, 4] as const;
  const discovery = home
    ? DISCOVERABLE.filter((i) => outcomes[i]?.state === 'available')
    : [];
  const showDiscovery = outcomes[0]?.state === 'good' && discovery.length > 0;
  /**
   * A never-used capability is not working area, full stop — whether or not the
   * shelf is showing.
   *
   * This was previously coupled to showDiscovery, which quietly meant the
   * opposite of the intent: with the shelf hidden (Be found not yet good) the
   * exclusion switched off, so the four cards an owner has never touched came
   * straight back and the newly-claimed business got exactly the wall of empty
   * capabilities this phase existed to remove.
   *
   * `available` decides membership of the working area. Be found being good
   * decides only whether the excluded ones are shown in discovery. Two separate
   * questions.
   */
  const isWorking = (i: number) => !!outcomes[i] && outcomes[i].state !== 'available';

  /* One obvious way in per capability, all of them routes that already exist
     and that actually BEGIN configuration — not a menu of managers. */
  const DISCOVERY_ITEMS: Record<number, { title: string; blurb: string; plan: string; icon: string; onPress: () => void }> = {
    1: { title: 'Sell things', blurb: 'Products and passes people can buy', plan: 'Premium', icon: 'shopping-bag',
         onPress: () => router.push({ pathname: '/business-products', params: { businessId: activeBusiness!.id } }) },
    2: { title: 'Take bookings', blurb: 'Let customers book your services', plan: 'Pro', icon: 'calendar-check',
         onPress: () => router.push({ pathname: '/local-book-services', params: { businessId: activeBusiness!.id } }) },
    3: { title: 'Run events', blurb: 'Publish events and manage tickets', plan: 'Free', icon: 'ticket-alt',
         onPress: () => router.push({ pathname: '/event-create', params: { businessId: activeBusiness!.id } }) },
    4: { title: 'Keep customers coming back', blurb: 'Offers and loyalty for returning customers', plan: 'Pro', icon: 'stamp',
         onPress: () => router.push({ pathname: '/local-offer-new', params: { businessId: activeBusiness!.id } }) },
  };

  /* NEXT knows which milestone it asked for, so it says so. Being told to add
     opening hours and then landing at the top of a long form is the same
     failure as not being told at all. */
  const editBusiness = (focus?: string) =>
    router.push({ pathname: '/local-business-register',
                  params: { id: activeBusiness!.id, ...(focus ? { focus } : {}) } });

  const stopLoyalty = async () => {
    if (!activeBusiness) return;
    try {
      const { error } = await supabase.from('local_loyalty_programs')
        .update({ is_active: false }).eq('business_id', activeBusiness.id);
      if (error) throw error;
      setProgram(p => (p ? { ...p, is_active: false } : p));
    } catch (e: any) {
      brandedAlert({ title: 'Could not stop it', message: e?.message ?? 'Try again.' });
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
    // Switching OFF is always allowed — nobody is trapped taking bookings.
    // Switching ON needs effective Pro, which is what the server enforces.
    if (value && !eff.pro) {
      return brandedAlert({
        title: 'Bookings need Pro',
        message: 'Your services and availability are saved. Turn bookings on once your plan is active.',
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


  const toggleBusinessPayout = async (value: boolean) => {
    if (!activeBusiness) return;
    // Before the write. The Switch is driven by the stored value, so refusing
    // here leaves it showing what the server actually holds.
    if (!(await requireCommercialTerms('Payout bank account'))) return;
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

        {/* ── Needs you ──────────────────────────────────────────────────
             The actual things waiting, and nothing else. A zero is not shown:
             a row of zeroes teaches you to skim past the row that finally
             matters. Work items link into Work; they are not owned here. */}
        {attention.length > 0 && (
          <View style={styles.attentionCard}>
            <Text style={styles.groupHeader}>Needs you</Text>
            {attention.map((a) => (
              <TouchableOpacity key={a.key} style={styles.attentionRow} activeOpacity={0.85}
                onPress={() => router.push({ pathname: a.route as never, params: { businessId: activeBusiness.id } })}>
                <FontAwesome5 name="exclamation-circle" size={14} color="#B4820F" solid />
                <Text style={styles.attentionText}>{a.label}</Text>
                <FontAwesome5 name="chevron-right" size={11} color="#B4820F" />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Nothing waiting is a real state and has to look like one. */}
        {home && attention.length === 0 && !next && (
          <View style={styles.calmCard}>
            <Text style={styles.calmText}>Nothing needs you right now</Text>
            <Text style={styles.calmSub}>Orders, bookings and leads will appear here as they come in.</Text>
          </View>
        )}

        {/* ── Next ───────────────────────────────────────────────────────
             One thing, and only when nothing is waiting. */}
        {next && (
          <TouchableOpacity style={styles.calmCard} activeOpacity={0.85} onPress={() => editBusiness(next.key)}>
            <Text style={styles.groupHeader}>Next</Text>
            <Text style={styles.calmText}>{next.title}</Text>
            <Text style={styles.calmSub}>{next.body}</Text>
          </TouchableOpacity>
        )}

        {/* ── This week ──────────────────────────────────────────────────
             A figure we cannot see is not shown as zero. Revenue is genuinely
             unknown without the paid tier, and printing £0 to somebody who took
             £400 would wreck trust in every other number here. */}
        {home && (
          <>
            <Text style={styles.groupHeader}>This week</Text>
            <View style={styles.weekRow}>
              {([
                ['Profile views', home.week.views],
                ['Contacts', home.week.contacts],
                ['Followers', home.week.followers],
                ['Money in', home.week.revenuePence === null ? null : home.week.revenuePence / 100],
              ] as [string, number | null][]).map(([label, value], i) => (
                <View key={label} style={styles.weekStat}>
                  <Text style={styles.weekValue}>
                    {value === null ? '—' : i === 3 ? `£${value.toFixed(2)}` : value.toLocaleString()}
                  </Text>
                  <Text style={styles.weekLabel}>{label}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        <Text style={styles.groupHeader}>At the counter</Text>

        {/* ── Counter mode — the screen to leave open on the counter all day.
             Leads the group because it's the everyday one; everything below is
             the owner's toolkit for exceptions. ── */}
        <TouchableOpacity
          style={styles.counterBanner}
          onPress={() => router.push({ pathname: '/local-counter', params: { businessId: activeBusiness.id } })}
          activeOpacity={0.85}
        >
          <View style={styles.counterIcon}>
            <FontAwesome5 name="tablet-alt" size={13} color="#fff" solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.counterTitle}>Counter mode</Text>
            <Text style={styles.counterSub}>
              A full-screen serving view for the counter — big till code and one-tap scanning. Lock it with a
              staff PIN and hand over the tablet.
            </Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>

        {/* ── Till code ── */}
        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>Till code · show to customer</Text>
          <Text style={styles.codeBig}>{code?.current_code ?? '— — — — — —'}</Text>
          <View style={styles.codeFooter}>
            <FontAwesome5 name="sync-alt" size={9} color={colors.textMuted} />
            <Text style={styles.codeFooterText}>Refreshes every 60 seconds</Text>
          </View>
        </View>

        {/* ── Loyalty till (scan the member's one card) ── */}
        <TouchableOpacity
          style={[styles.backfillBanner, { backgroundColor: S.color, borderColor: S.color }]}
          onPress={() => router.push({ pathname: '/local-till', params: { businessId: activeBusiness.id } })}
          activeOpacity={0.85}
        >
          <View style={[styles.backfillIcon, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
            <FontAwesome5 name="qrcode" size={11} color="#fff" solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.backfillTitle, { color: '#fff' }]}>Loyalty till</Text>
            <Text style={[styles.backfillSub, { color: 'rgba(255,255,255,0.9)' }]}>Scan a customer’s card to add a stamp, add points or give a reward.</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>

        {/* ── Confirm a redemption (customer-generated code / passes) ── */}
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
            <Text style={styles.backfillSub}>Scan or enter a customer’s one-time code (passes &amp; app redemptions).</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color={S.color} />
        </TouchableOpacity>

        {/* ── Your business ──────────────────────────────────────── */}
        <Text style={styles.groupHeader}>Your business</Text>

        {/* Five compact cards. The outcome IS the unit now: it used to sit as a
            one-line summary above the old full-size feature card, which said the
            same thing twice and made Home four screens long. The managers live
            behind these, not inside them. */}

        <OutcomeCard
          outcome={outcomes[0]} accent={S.color}
          actions={[
            { label: 'Edit profile', onPress: editBusiness },
            { label: 'View public profile', onPress: () => router.push({ pathname: '/local-business-detail', params: { id: activeBusiness.id } }) },
          ]}
        />

        {isWorking(1) && (
        <OutcomeCard
          outcome={outcomes[1]} accent={S.color}
          actions={[
            { label: 'Products', onPress: () => router.push({ pathname: '/business-products', params: { businessId: activeBusiness.id } }) },
            { label: 'Passes', onPress: () => router.push({ pathname: '/local-book-units', params: { businessId: activeBusiness.id } }) },
            { label: 'Orders', onPress: () => router.push({ pathname: '/business-orders', params: { businessId: activeBusiness.id } }) },
          ]}
        />
        )}

        {isWorking(2) && (
        <OutcomeCard
          outcome={outcomes[2]} accent={S.color}
          actions={[
            { label: 'Services', onPress: () => router.push({ pathname: '/local-book-services', params: { businessId: activeBusiness.id } }) },
            { label: 'Schedule', onPress: () => router.push({ pathname: '/local-book-schedule', params: { businessId: activeBusiness.id } }) },
            { label: 'Bookings', onPress: () => router.push({ pathname: '/local-book-bookings', params: { businessId: activeBusiness.id } }) },
          ]}
        >
          {/* The live switch stays on Home: it is the one booking control an
              owner flips often, and it carries the Pro boundary. */}
          <View style={styles.outcomeInline}>
            <Text style={styles.outcomeInlineText}>
              {activeBusiness.accepts_bookings ? 'Taking bookings' : 'Not taking bookings yet'}
            </Text>
            <Switch
              value={!!activeBusiness.accepts_bookings}
              onValueChange={toggleAcceptsBookings}
              trackColor={{ false: '#D6DCE3', true: S.color }}
            />
          </View>
        </OutcomeCard>
        )}

        {isWorking(3) && (
        <OutcomeCard
          outcome={outcomes[3]} accent={S.color}
          fact={bizEvents.length > 0
            ? `next ${new Date(bizEvents[0].starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
            : null}
          actions={[
            // event-manage and event-scanner are per-EVENT screens: they read
            // `id`. This passed businessId, so both arrived with nothing to
            // work on — Manage events hung on a spinner and the scanner
            // ignored every code it read. The card already speaks about the
            // next event ("next 10 Sep"), so its buttons act on that one.
            { label: 'Manage events', onPress: () => router.push({ pathname: '/event-manage', params: { id: bizEvents[0]?.id ?? '' } }) },
            { label: 'New event', onPress: () => router.push({ pathname: '/event-create', params: { businessId: activeBusiness.id } }) },
            { label: 'Scan tickets', onPress: () => router.push({ pathname: '/event-scanner', params: { id: bizEvents[0]?.id ?? '' } }) },
          ]}
        />
        )}

        {isWorking(4) && (
        <OutcomeCard
          outcome={outcomes[4]} accent={S.color}
          actions={[
            ...(eff.pro ? [
              { label: 'New offer', onPress: () => router.push({ pathname: '/local-offer-new', params: { businessId: activeBusiness.id } }) },
              { label: program ? 'Edit loyalty' : 'Set up loyalty', onPress: () => setShowLoyaltyModal(true) },
            ] : [{ label: 'See plans', onPress: openBillingPortal }]),
          ]}
        >
          {/* Withdrawal stays reachable whatever the plan says — the server
              permits it, and there is nowhere else on mobile to end an offer or
              stop a programme. Compact lines, not a second manager. */}
          {offers.filter(o => o.is_active).map(o => (
            <View key={o.id} style={styles.outcomeInline}>
              <Text style={styles.outcomeInlineText} numberOfLines={1}>{o.title}</Text>
              <TouchableOpacity hitSlop={8} onPress={() => {
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
                <Text style={styles.outcomeAction}>End</Text>
              </TouchableOpacity>
            </View>
          ))}
          {program?.is_active && (
            <View style={styles.outcomeInline}>
              <Text style={styles.outcomeInlineText} numberOfLines={1}>
                {stamps ? `${program.stamps_required} stamps · ${program.stamp_reward}` : `${program.points_per_pound} points per £1`}
              </Text>
              <TouchableOpacity hitSlop={8} onPress={stopLoyalty}>
                <Text style={styles.outcomeAction}>Stop</Text>
              </TouchableOpacity>
            </View>
          )}
        </OutcomeCard>
        )}


        {/* ── Also possible on OneShetland ───────────────────────────────
             Quiet on purpose. No dot, no badge, no count, no "not set up" —
             none of these is a task the owner has failed to do. It only appears
             once the listing is genuinely good, and each item leaves the shelf
             by itself the moment anything is configured, because the state that
             put it here stops being true. Nothing is stored. */}
        {showDiscovery && (
          <>
            <Text style={styles.groupHeader}>Also possible on OneShetland</Text>
            <View style={styles.shelf}>
              {discovery.map((i) => {
                const it = DISCOVERY_ITEMS[i];
                return (
                  <TouchableOpacity key={it.title} style={styles.shelfItem} activeOpacity={0.7}
                    onPress={it.onPress}>
                    <View style={[styles.shelfIcon, { backgroundColor: S.color + '14' }]}>
                      <FontAwesome5 name={it.icon} size={13} color={S.color} solid />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.shelfTitle}>{it.title}</Text>
                      <Text style={styles.shelfBlurb}>{it.blurb}</Text>
                    </View>
                    {/* The plan is a fact about the capability, not a pitch. */}
                    <Text style={styles.shelfPlan}>{it.plan}</Text>
                    <FontAwesome5 name="chevron-right" size={11} color={S.color} />
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}

        <Text style={styles.groupHeader}>Money</Text>

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

          {/* Feature checklist — instantly clear what's unlocked vs locked */}
          <View style={styles.featureList}>
            {PLAN_FEATURES.map(f => {
              // What is available NOW, not what was once bought. A premium row
              // whose date has passed unlocks nothing.
              const unlocked = f.req === 'free' ? true : f.req === 'pro' ? eff.pro : eff.premium;
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
          {eff.premium && (
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
          {/* Never gated. A free, lapsed or downgraded owner is the one most
              likely to need the plans and billing screen. */}
          {true && (
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
          {/* The tile can be read about and requested on any plan. What it
              cannot do is behave as though Wallet were live — see walletLive. */}
          {true && (<>
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
        {/* Connecting a bank is setup, not a paid action — and an owner whose
            plan lapsed may still need to reach their payout account. */}
        {true && (
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
            <>
            {/* Accepting payments is the switch above; what you give back is a
                setting. Home shows the first and keeps the second one tap away. */}
            <TouchableOpacity style={styles.walletSettingsRow} activeOpacity={0.7}
              onPress={() => toggleCard('wallet')}>
              <Text style={styles.walletSettingsText}>
                Wallet settings{(activeBusiness.cashback_percent ?? 0) > 0 ? ` · ${activeBusiness.cashback_percent}% cashback` : ''}
              </Text>
              <FontAwesome5 name={expanded.wallet ? 'chevron-up' : 'chevron-down'} size={11} color={colors.textMuted} />
            </TouchableOpacity>
            {expanded.wallet && (
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
            )}
            </>
          ) : null}
        </View>
        )}

        {/* ── Wallet payments received — Pro+, only when wallet accepted ── */}
        {/* The business's own record of money it has taken. Neither a lapsed
            plan nor switching Wallet off makes that money un-taken, so this is
            shown whenever there is anything to show. */}
        {walletReceipts.length > 0 && (
          <WalletReceiptsCard receipts={walletReceipts} accentColor={S.color} />
        )}

        {/* ── Money & transactions — full statement + CSV export ── */}
        <TouchableOpacity
          style={styles.utilityRow}
          onPress={() => router.push({ pathname: '/local-business-transactions', params: { businessId: activeBusiness.id } } as any)}
        >
          <View style={[styles.utilityIcon, { backgroundColor: S.color + '14' }]}>
            <FontAwesome5 name="receipt" size={13} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.utilityTitle}>Money &amp; transactions</Text>
            <Text style={styles.utilitySub}>Full statement · export for your accounts</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color={colors.textMuted} />
        </TouchableOpacity>


        <Text style={styles.groupHeader}>Grow</Text>

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

        {/* ── Urgent Alerts ── */}
        {/* Urgent alerts — a status line and a way in. Requesting access,
            composing and scheduling are the manager's, and the manager is at
            /business-alerts. */}
        <TouchableOpacity
          style={styles.utilityRow}
          activeOpacity={0.7}
          onPress={() => router.push({ pathname: '/business-alerts', params: { businessId: activeBusiness.id, businessName: activeBusiness.name } } as any)}
        >
          <View style={[styles.utilityIcon, { backgroundColor: '#FF3B3014' }]}>
            <FontAwesome5 name="broadcast-tower" size={13} color="#FF3B30" solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.utilityTitle}>Urgent alerts</Text>
            <Text style={styles.utilitySub}>
              {bizAlerts.length > 0
                ? `${bizAlerts.length} live now`
                : alertAccess?.status === 'active'
                  ? 'Approved — you can broadcast across OneShetland'
                  : alertAccess?.status === 'requested'
                    ? 'Request under review'
                    : 'Request access to broadcast urgent messages'}
            </Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color={colors.textMuted} />
        </TouchableOpacity>



        {/* ── Schedule picker modal ── */}
        {/* ── Schedule presets modal ── */}


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

      {/*
        The same acceptance experience the commercial screens use, shown over
        the dashboard instead of instead of it. No second checkbox, no second
        record, no second version — CommercialTermsGate and its two RPCs.

        Its children render only once the gate has RE-READ the status from the
        server and been told yes, so this notice is the server's answer rather
        than the client's assumption. The action itself is not replayed: the
        user closes this and taps the control again, which asks once more.
      */}
      <Modal
        visible={termsGateFor !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setTermsGateFor(null)}
      >
        {termsGateFor !== null && (
          <CommercialTermsGate
            businessId={activeBusiness.id}
            businessName={activeBusiness.name}
            feature={termsGateFor}
            onDismiss={() => setTermsGateFor(null)}
          >
            <CommercialTermsAccepted feature={termsGateFor} onDone={() => setTermsGateFor(null)} />
          </CommercialTermsGate>
        )}
      </Modal>
    </SafeAreaView>
  );
}

/**
 * Shown after the gate has confirmed acceptance with the server. It accepts
 * nothing itself — no checkbox, no RPC, no record — it only says the control is
 * now open and hands the dashboard back.
 */
function CommercialTermsAccepted({ feature, onDone }: { feature: string; onDone: () => void }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.screenBackground }} edges={['top']}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.md }}>
        <FontAwesome5 name="check-circle" size={44} color={colors.navy} solid />
        <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' }}>
          Terms accepted
        </Text>
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {feature} is now open for this business, along with every other commercial
          feature. You won&apos;t be asked again unless the terms change.
        </Text>
        <TouchableOpacity
          onPress={onDone}
          style={{ backgroundColor: colors.navy, borderRadius: radius.full, paddingVertical: spacing.md,
                   paddingHorizontal: spacing.xl, marginTop: spacing.sm }}
        >
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Back to the dashboard</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── Urgent Alerts card ────────────────────────────────────────────────────────



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

  tierRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tierPrice:  { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },
  tierExpiry: { fontSize: 10, color: colors.textLight, fontWeight: '600', marginTop: 2 },

  // Merged-card sub-sections
  subSectionLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  shelf:           { backgroundColor: '#FFFFFF', borderColor: '#E4E9EF', borderWidth: 1, borderRadius: 14, marginTop: 8 },
  shelfItem:       { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: '#EEF1F5' },
  shelfIcon:       { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  shelfTitle:      { fontSize: 14, fontWeight: '800', color: '#12212E' },
  shelfBlurb:      { fontSize: 12, color: '#5B6B7A', marginTop: 1 },
  shelfPlan:       { fontSize: 11, fontWeight: '700', color: '#8A97A4' },
  walletSettingsRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, marginTop: 8, borderTopWidth: 1, borderTopColor: '#EEF1F5' },
  walletSettingsText: { fontSize: 13, fontWeight: '700', color: '#5B6B7A' },
  utilityRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderColor: '#E4E9EF', borderWidth: 1, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 },
  utilityIcon:     { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  utilityTitle:    { fontSize: 14, fontWeight: '800', color: '#12212E' },
  utilitySub:      { fontSize: 12, color: '#5B6B7A', marginTop: 1 },
  outcomeCard:     { backgroundColor: '#FFFFFF', borderColor: '#E4E9EF', borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 8, gap: 10 },
  outcomeHead:     { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  outcomeActions:  { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  outcomeAction:   { fontSize: 14, fontWeight: '800' },
  outcomeInline:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
  outcomeInlineText: { flex: 1, fontSize: 13, color: '#5B6B7A' },
  outcomeRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 4, marginTop: 6 },
  outcomeDot:      { width: 8, height: 8, borderRadius: 4 },
  outcomeTitle:    { fontSize: 15, fontWeight: '800', color: '#12212E' },
  outcomeStatus:   { fontSize: 13, color: '#5B6B7A', marginTop: 1 },
  attentionCard:   { backgroundColor: '#FFF7E6', borderColor: '#F5D58A', borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  attentionRow:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  attentionText:   { flex: 1, fontSize: 14, fontWeight: '700', color: '#7A5A12' },
  calmCard:        { backgroundColor: '#FFFFFF', borderColor: '#E4E9EF', borderWidth: 1, borderRadius: 14, padding: 14 },
  calmText:        { fontSize: 14, fontWeight: '700', color: '#12212E' },
  calmSub:         { fontSize: 13, color: '#5B6B7A', marginTop: 2 },
  weekRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  weekStat:        { flexGrow: 1, minWidth: '45%', backgroundColor: '#FFFFFF', borderColor: '#E4E9EF', borderWidth: 1, borderRadius: 14, padding: 12 },
  weekValue:       { fontSize: 20, fontWeight: '900', color: '#12212E' },
  weekLabel:       { fontSize: 12, color: '#5B6B7A', marginTop: 2 },
  reduceBtn:       { marginTop: 10, borderWidth: 1, borderColor: '#D6DCE3', borderRadius: 999, paddingVertical: 10, alignItems: 'center' },
  reduceBtnText:   { fontSize: 13, fontWeight: '700', color: '#5B6B7A' },
  groupHeader:     { fontSize: 12, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 18, marginBottom: 6 },
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
  counterBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, backgroundColor: '#0B0620', borderRadius: radius.lg },
  counterIcon:   { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  counterTitle:  { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
  counterSub:    { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.xs, lineHeight: 16, marginTop: 2 },
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
  bookActionBtn:  { flexGrow: 1, flexBasis: '47%', minWidth: 130, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 8, borderRadius: radius.md, borderWidth: 1.5, backgroundColor: '#fff' },
  bookActionText: { fontSize: fontSize.xs, fontWeight: '800' },
  evRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  evDatePill:  { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, minWidth: 72, alignItems: 'center' },
  evDateText:  { fontSize: 10, fontWeight: '800' },
  evTimeText:  { fontSize: 9, fontWeight: '600', opacity: 0.8 },
  evTitle:     { flex: 1, fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },
  evActions:   { flexDirection: 'row', gap: 6 },
  evBtn:       { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },

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
