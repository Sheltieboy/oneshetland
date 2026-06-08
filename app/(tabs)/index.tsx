import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  RefreshControl,
  ActivityIndicator,
  Linking,
} from 'react-native';

const LOGO = require('@/assets/icon.png');
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { haptic } from '@/lib/haptics';
import {
  fetchHomeFeed,
  formatEventDate,
  decodeEntities,
  OSHomeFeed,
} from '@/lib/oneshetland-api';
import { supabase } from '@/lib/supabase';
import {
  fetchFeaturedOffer, fetchActiveBusinessCount,
  formatOfferDiscount, daysRemaining,
  type LocalOffer,
} from '@/lib/local-api';
import { isBookableLive } from '@/lib/book-api';
import {
  fetchFeaturedBoostedShift, formatPay, formatShiftDate,
  shiftDisplayBusiness, URGENCY_CONFIG, CATEGORY_LABELS as SHIFT_CATEGORY_LABELS,
  type Shift,
} from '@/lib/shifts-api';
import { fetchHomeData, type HomeData } from '@/lib/home-data';
import { getDailyWird, loadDailyState, todayKey, maxTries } from '@/lib/guess-da-wird';

function greeting(name: string | null): string {
  const hour = new Date().getHours();
  const time = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${time}, ${name.split(' ')[0]}` : time;
}

// ── Date helper ───────────────────────────────────────────────────────────────

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
  if (sameDay)    return `Today ${time}`;
  if (isTomorrow) return `Tomorrow ${time}`;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ` ${time}`;
}

// ── For You card (personalised state) ───────────────────────────────────────────

function ForYouCard({
  icon, color, tag, title, sub, onPress,
}: {
  icon: string; color: string; tag: string; title: string; sub: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.forYouCard} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.forYouIcon, { backgroundColor: color + '20' }]}>
        <FontAwesome5 name={icon as any} size={15} color={color} solid />
      </View>
      <Text style={[styles.forYouTag, { color }]}>{tag.toUpperCase()}</Text>
      <Text style={styles.forYouCardTitle} numberOfLines={2}>{title}</Text>
      <Text style={styles.forYouCardSub} numberOfLines={1}>{sub}</Text>
    </TouchableOpacity>
  );
}

// ── Quick action tile ─────────────────────────────────────────────────────────

function QuickAction({
  icon, label, color, onPress, badge,
}: {
  icon: string; label: string; color: string; onPress: () => void; badge?: string;
}) {
  return (
    <TouchableOpacity style={styles.quickTile} onPress={onPress} activeOpacity={0.82}>
      <View style={[styles.quickIcon, { backgroundColor: color + '18' }]}>
        <FontAwesome5 name={icon as any} size={18} color={color} solid />
        {badge ? (
          <View style={[styles.quickBadge, { backgroundColor: color }]}>
            <Text style={styles.quickBadgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.quickLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Grow your business card ─────────────────────────────────────────────────────

function GrowCard({
  icon, title, body, cta, onPress, onDismiss,
}: {
  icon: string; title: string; body: string; cta: string; onPress: () => void; onDismiss: () => void;
}) {
  return (
    <View style={styles.growCard}>
      <TouchableOpacity style={styles.growDismiss} onPress={onDismiss} hitSlop={10}>
        <FontAwesome5 name="times" size={12} color="rgba(255,255,255,0.6)" />
      </TouchableOpacity>
      <View style={styles.growIcon}>
        <FontAwesome5 name={icon as any} size={16} color={colors.navy} solid />
      </View>
      <Text style={styles.growTitle}>{title}</Text>
      <Text style={styles.growBody}>{body}</Text>
      <TouchableOpacity style={styles.growCta} onPress={onPress} activeOpacity={0.85}>
        <Text style={styles.growCtaText}>{cta}</Text>
        <FontAwesome5 name="arrow-right" size={11} color={colors.navy} />
      </TouchableOpacity>
    </View>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title, icon, color }: { title: string; icon: string; color: string }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionAccentBar, { backgroundColor: color }]} />
      <View style={[styles.sectionIconWrap, { backgroundColor: color + '18' }]}>
        <FontAwesome5 name={icon as any} size={12} color={color} solid />
      </View>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [feed, setFeed]           = useState<OSHomeFeed | null>(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [shiftsCount, setShiftsCount]     = useState<number | null>(null);
  const [fetchCount,  setFetchCount]      = useState<number | null>(null);
  const [localCount,  setLocalCount]      = useState<number | null>(null);
  const [featuredOffer, setFeaturedOffer] = useState<LocalOffer | null>(null);
  const [featuredShift, setFeaturedShift] = useState<Shift | null>(null);
  const [home, setHome]   = useState<HomeData | null>(null);
  const [wird, setWird]   = useState<{ length: number; tries: number; played: boolean } | null>(null);
  const [growDismissed, setGrowDismissed] = useState(false);

  const isDriver = profile?.role === 'driver';
  const isAdmin  = profile?.role === 'admin';

  const loadFeed = useCallback(async () => {
    try {
      setError(null);
      const [data] = await Promise.all([
        fetchHomeFeed(),
        // Open shifts count
        supabase
          .from('shifts')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open')
          .gte('end_at', new Date().toISOString())
          .then(({ count }) => { if (count !== null) setShiftsCount(count); }),
        // Active delivery requests (pending or matched — i.e. not yet delivered/cancelled)
        supabase
          .from('delivery_requests')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'matched'])
          .then(({ count }) => { if (count !== null) setFetchCount(count); }),
        // Local: business count + featured offer (gated by subscription_tier = 'premium')
        fetchActiveBusinessCount().then(setLocalCount).catch(() => {}),
        fetchFeaturedOffer().then(setFeaturedOffer).catch(() => {}),
        fetchFeaturedBoostedShift().then(setFeaturedShift).catch(() => {}),
        // Personalised state for the signed-in user
        fetchHomeData(profile).then(setHome).catch(() => {}),
        // Guess da Wird daily teaser — length + played state only (never the answer)
        (async () => {
          try {
            const dateKey = todayKey();
            const [w, saved] = await Promise.all([getDailyWird(dateKey), loadDailyState(profile?.id ?? 'anon')]);
            setWird({ length: w.word.length, tries: maxTries(w.word), played: !!(saved?.won || saved?.lost) });
          } catch { /* teaser is optional */ }
        })(),
      ]);
      setFeed(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load feed.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile]);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  const onRefresh = useCallback(() => { setRefreshing(true); loadFeed(); }, [loadFeed]);

  const goToFetch = () => {
    haptic.medium();
    router.push('/(tabs)/fetch');
  };

  const openUrl = (url?: string | null) => {
    haptic.light();
    if (url) Linking.openURL(url).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >

        {/* ── Hero header ── */}
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={styles.logoWrap}>
              <Image source={LOGO} style={styles.logo} resizeMode="contain" />
            </View>
            <View style={styles.heroTaglineBlock}>
              <Text style={styles.heroWordmark}>OneShetland</Text>
              <Text style={styles.heroTagline}>Everything Shetland, All in One Place</Text>
            </View>
            <View style={styles.heroRight}>
              {profile ? (
                <>
                  <TouchableOpacity
                    onPress={() => { haptic.light(); router.push('/local-wallet'); }}
                    style={styles.headerIconBtn}
                    accessibilityLabel={`My Wallet${home?.walletItemCount ? `, ${home.walletItemCount} items` : ''}`}
                    hitSlop={6}
                  >
                    <FontAwesome5 name="wallet" size={14} color="#fff" solid />
                    {!!home?.walletItemCount && home.walletItemCount > 0 && (
                      <View style={styles.headerIconBadge}>
                        <Text style={styles.headerIconBadgeText}>
                          {home.walletItemCount > 99 ? '99+' : home.walletItemCount}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { haptic.light(); router.push('/(tabs)/me'); }}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{(profile.full_name?.trim() || 'U')[0].toUpperCase()}</Text>
                    </View>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={styles.signInBtn}
                  onPress={() => { haptic.light(); router.push('/(auth)/sign-in'); }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.signInBtnText}>Sign in</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* ── For you — personalised state cards ── */}
        {home && (() => {
          const cards: React.ReactNode[] = [];

          if (home.activeDelivery) {
            const d = home.activeDelivery;
            const label =
              d.status === 'collected' ? 'On its way to you'
              : d.status === 'matched' ? 'A driver is on it'
              : 'Looking for a driver';
            cards.push(
              <ForYouCard
                key="delivery"
                icon="box" color={SECTIONS.fetch.color}
                tag="Your delivery" title={label}
                sub={d.destination_area ? `To ${d.destination_area}` : 'Tap to track'}
                onPress={() => router.push('/(customer)/dashboard')}
              />
            );
          }
          if (home.upcomingBooking) {
            const b = home.upcomingBooking;
            cards.push(
              <ForYouCard
                key="booking"
                icon="calendar-check" color={SECTIONS.local.color}
                tag="Your booking" title={b.service_name ?? 'Upcoming booking'}
                sub={`${b.business_name ?? ''} · ${formatWhen(b.starts_at)}`.trim()}
                onPress={() => router.push('/local-my-bookings')}
              />
            );
          }
          if (home.application) {
            const a = home.application;
            const t = a.status === 'accepted' ? "You're in! Shift accepted" : 'Application sent';
            cards.push(
              <ForYouCard
                key="application"
                icon="briefcase" color={SECTIONS.shifts.color}
                tag="Your shift" title={t}
                sub={a.title}
                onPress={() => router.push('/my-shift-applications')}
              />
            );
          }
          if (home.rewardReady) {
            const r = home.rewardReady;
            cards.push(
              <ForYouCard
                key="reward"
                icon="gift" color="#F59E0B"
                tag="Reward ready" title="Free reward waiting"
                sub={`At ${r.business_name ?? 'a local business'}`}
                onPress={() => router.push({ pathname: '/local-business-detail', params: { id: r.business_id } })}
              />
            );
          }
          if (home.owner) {
            const o = home.owner;
            cards.push(
              <ForYouCard
                key="owner"
                icon="store" color={colors.navy}
                tag="Your business" title={o.primaryBusiness?.name ?? 'Business dashboard'}
                sub={o.pendingBookings > 0 ? `${o.pendingBookings} upcoming booking${o.pendingBookings !== 1 ? 's' : ''}` : 'Manage your listing'}
                onPress={() => router.push({ pathname: '/local-business-dashboard', params: o.primaryBusiness ? { businessId: o.primaryBusiness.id } : {} })}
              />
            );
          }

          if (cards.length === 0) return null;
          return (
            <View style={styles.forYouSection}>
              <Text style={styles.forYouTitle}>For you</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.forYouRow}>
                {cards}
              </ScrollView>
            </View>
          );
        })()}

        {/* ── Quick actions — task verbs, role-aware ── */}
        <View style={styles.quickSection}>
          <View style={styles.quickGrid}>
            {isDriver ? (
              <QuickAction icon="route" label="My runs" color={SECTIONS.fetch.color}
                onPress={() => router.push('/(driver)/dashboard')} />
            ) : (
              <QuickAction icon={SECTIONS.fetch.icon} label="Request" color={SECTIONS.fetch.color}
                onPress={goToFetch} />
            )}
            <QuickAction icon="search" label="Shifts" color={SECTIONS.shifts.color}
              onPress={() => router.push('/(tabs)/shifts')}
              badge={shiftsCount ? `${shiftsCount}` : undefined} />
            <QuickAction icon={SECTIONS.local.icon} label="Marketplace" color={SECTIONS.local.color}
              onPress={() => router.push('/(tabs)/local')} />
            <QuickAction icon="gamepad" label="Games" color={SECTIONS.games.color}
              onPress={() => router.push('/games')} />
          </View>
        </View>

        {/* ── Light sheet — navy band ends here, content curves into light ── */}
        <View style={styles.lightSheet}>

        {/* ── Guess da Wird daily teaser ── */}
        {wird && (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.wirdTeaser}
              onPress={() => { haptic.medium(); router.push('/games/guess-da-wird'); }}
              activeOpacity={0.9}
            >
              <View style={styles.wirdTeaserIcon}>
                <FontAwesome5 name="puzzle-piece" size={18} color="#fff" solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.wirdTeaserTag}>GUESS DA WIRD · TODAY</Text>
                <Text style={styles.wirdTeaserTitle}>
                  {wird.played ? "You've played today — see your streak" : `Today's wird is ${wird.length} letters`}
                </Text>
                <Text style={styles.wirdTeaserSub}>
                  {wird.played ? 'Come back the morn for a new wird' : `${wird.tries} tries · a peerie clue if you need it`}
                </Text>
              </View>
              <View style={styles.wirdTeaserCta}>
                <Text style={styles.wirdTeaserCtaText}>{wird.played ? 'View' : 'Play'}</Text>
                <FontAwesome5 name="arrow-right" size={11} color="#fff" />
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Featured Shift — surfaces whenever an employer has boosted ── */}
        {featuredShift && (() => {
          const biz     = shiftDisplayBusiness(featuredShift);
          const urgency = URGENCY_CONFIG[featuredShift.urgency];
          return (
            <View style={styles.section}>
              <SectionHeader title="Featured Shift" icon={SECTIONS.shifts.icon} color={SECTIONS.shifts.color} />
              <TouchableOpacity
                style={[styles.featuredShiftCard, { backgroundColor: SECTIONS.shifts.color }]}
                onPress={() => router.push({ pathname: '/shift-detail', params: { id: featuredShift.id } })}
                activeOpacity={0.88}
              >
                <View style={styles.featuredShiftTop}>
                  <View style={styles.featuredShiftBoosted}>
                    <FontAwesome5 name="bolt" size={9} color="#fff" solid />
                    <Text style={styles.featuredShiftBoostedText}>Boosted</Text>
                  </View>
                  <View style={styles.featuredShiftPay}>
                    <Text style={styles.featuredShiftPayText}>{formatPay(featuredShift.pay_type, featuredShift.pay_amount)}</Text>
                  </View>
                </View>

                <Text style={styles.featuredShiftTitle} numberOfLines={2}>{featuredShift.title}</Text>
                <Text style={styles.featuredShiftBusiness} numberOfLines={1}>
                  {biz.name}
                  {biz.is_verified && (
                    <Text>  <FontAwesome5 name="check-circle" size={11} color="#fff" solid /></Text>
                  )}
                  {'  ·  ' + SHIFT_CATEGORY_LABELS[featuredShift.category]}
                </Text>

                <View style={styles.featuredShiftMeta}>
                  <FontAwesome5 name="calendar-alt" size={10} color="rgba(255,255,255,0.85)" />
                  <Text style={styles.featuredShiftMetaText}>{formatShiftDate(featuredShift.start_at)}</Text>
                  <View style={[styles.featuredShiftUrgency, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
                    <Text style={styles.featuredShiftUrgencyText}>{urgency.label}</Text>
                  </View>
                </View>

                <View style={styles.featuredShiftFooter}>
                  <FontAwesome5 name="map-marker-alt" size={10} color="rgba(255,255,255,0.85)" />
                  <Text style={styles.featuredShiftLocation} numberOfLines={1}>{featuredShift.location_text}</Text>
                  <Text style={styles.featuredShiftCta}>View →</Text>
                </View>
              </TouchableOpacity>
            </View>
          );
        })()}

        {/* ── Featured Local — gated on subscription_tier = 'premium' ── */}
        {featuredOffer && (
          <View style={styles.section}>
            <SectionHeader title="Featured in the Marketplace" icon={SECTIONS.local.icon} color={SECTIONS.local.color} />
            <TouchableOpacity
              style={[styles.featuredOfferCard, { backgroundColor: SECTIONS.local.color }]}
              onPress={() => {
                // If the underlying business is bookable, send the customer
                // straight to the slot picker — taps on a Featured offer for
                // a bookable place should not detour through the profile.
                const biz = featuredOffer.business;
                if (biz && isBookableLive(biz)) {
                  router.push({ pathname: '/local-book-business', params: { businessId: featuredOffer.business_id } });
                } else {
                  router.push({ pathname: '/local-business-detail', params: { id: featuredOffer.business_id } });
                }
              }}
              activeOpacity={0.88}
            >
              <View style={styles.featuredOfferTop}>
                <View style={styles.featuredOfferDiscount}>
                  <Text style={styles.featuredOfferDiscountText}>
                    {formatOfferDiscount(featuredOffer)}
                  </Text>
                </View>
                <View style={styles.featuredOfferTag}>
                  <FontAwesome5 name="star" size={9} color="#fff" solid />
                  <Text style={styles.featuredOfferTagText}>Featured</Text>
                </View>
              </View>
              <Text style={styles.featuredOfferTitle} numberOfLines={2}>{featuredOffer.title}</Text>
              {featuredOffer.business && (
                <Text style={styles.featuredOfferBusiness}>at {featuredOffer.business.name}</Text>
              )}
              <View style={styles.featuredOfferFooter}>
                <FontAwesome5 name="clock" size={10} color="rgba(255,255,255,0.7)" />
                <Text style={styles.featuredOfferExpiry}>
                  {(() => {
                    const d = daysRemaining(featuredOffer.valid_until);
                    return d === 0 ? 'Ends today' : `${d} day${d !== 1 ? 's' : ''} left`;
                  })()}
                </Text>
                <Text style={styles.featuredOfferCta}>View →</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Grow your business — role-gated, dismissible ── */}
        {!growDismissed && (() => {
          // Owner on free/pro tier → upgrade nudge
          if (home?.owner && home.owner.tier !== 'premium') {
            const tier = home.owner.tier ?? 'free';
            return (
              <View style={styles.section}>
                <GrowCard
                  icon="rocket"
                  title={tier === 'pro' ? 'Go Premium — unlock bookings' : 'Reach more customers'}
                  body={tier === 'pro'
                    ? 'Premium adds in-app bookings, featured placement and richer loyalty tools.'
                    : 'Featured placement on this home screen, loyalty cards, offers and bookings.'}
                  cta="See plans"
                  onPress={() => router.push({ pathname: '/local-business-dashboard', params: home.owner!.primaryBusiness ? { businessId: home.owner!.primaryBusiness.id } : {} })}
                  onDismiss={() => setGrowDismissed(true)}
                />
              </View>
            );
          }
          // Signed-in non-owner → list-your-business funnel entry
          if (profile && !home?.owner && !isDriver) {
            return (
              <View style={styles.section}>
                <GrowCard
                  icon="store"
                  title="Run a Shetland business?"
                  body="List it free on OneShetland — get found by locals, take bookings, reward regulars."
                  cta="List your business"
                  onPress={() => router.push('/local-business-register')}
                  onDismiss={() => setGrowDismissed(true)}
                />
              </View>
            );
          }
          return null;
        })()}

        {/* ── Loading / Error ── */}
        {loading && (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.navy} />
          </View>
        )}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={loadFeed}>
              <Text style={styles.retryText}>Tap to retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {feed && (
          <>
            {/* ── Spik Word of the Day ── */}
            {feed.spik_word && (
              <View style={styles.section}>
                <SectionHeader title="Spik Word of the Day" icon={SECTIONS.spik.icon} color={SECTIONS.spik.color} />
                <TouchableOpacity
                  style={[styles.spikCard, { borderTopWidth: 3, borderTopColor: colors.spik }]}
                  activeOpacity={0.8}
                  onPress={() => router.push({
                    pathname: '/spik-detail',
                    params: { id: String(feed.spik_word!.id) },
                  })}
                >
                  <View style={styles.spikWordRow}>
                    <Text style={styles.spikWord}>{decodeEntities(feed.spik_word.word)}</Text>
                    {feed.spik_word.part_of_speech ? (
                      <Text style={styles.spikPos}>{feed.spik_word.part_of_speech}</Text>
                    ) : null}
                  </View>
                  {feed.spik_word.definition ? (
                    <Text style={styles.spikDefinition}>{feed.spik_word.definition}</Text>
                  ) : null}
                  {feed.spik_word.example ? (
                    <Text style={styles.spikExample}>"{decodeEntities(feed.spik_word.example)}"</Text>
                  ) : null}
                  {feed.spik_word.category ? (
                    <View style={styles.spikCategoryPill}>
                      <Text style={styles.spikCategoryText}>{feed.spik_word.category}</Text>
                    </View>
                  ) : null}
                  <View style={styles.spikFooter}>
                    <Text style={styles.spikFooterText}>See full entry</Text>
                    <FontAwesome5 name="arrow-right" size={10} color="rgba(255,255,255,0.5)" />
                  </View>
                </TouchableOpacity>
              </View>
            )}

            {/* ── What's On ── */}
            {feed.events.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title={SECTIONS.events.label} icon={SECTIONS.events.icon} color={SECTIONS.events.color} />
                {feed.events.map((event) => (
                  <TouchableOpacity
                    key={event.id}
                    style={[styles.eventCard, { borderLeftWidth: 4, borderLeftColor: SECTIONS.events.color }]}
                    activeOpacity={0.85}
                    onPress={() => openUrl(event.url)}
                  >
                    {event.image ? (
                      <Image source={{ uri: event.image }} style={styles.eventImage} />
                    ) : (
                      <View style={[styles.eventImage, styles.eventImagePlaceholder]}>
                        <FontAwesome5 name="calendar" size={20} color={SECTIONS.events.color} />
                      </View>
                    )}
                    <View style={styles.eventBody}>
                      <View style={[styles.eventDatePill, { backgroundColor: SECTIONS.events.light }]}>
                        <Text style={[styles.eventDateText, { color: SECTIONS.events.color }]}>{formatEventDate(event.start_date)}</Text>
                      </View>
                      <Text style={styles.eventTitle} numberOfLines={2}>{decodeEntities(event.title)}</Text>
                      {event.venue ? (
                        <Text style={styles.eventVenue} numberOfLines={1}>📍 {decodeEntities(event.venue)}</Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* ── Latest Notices ── */}
            {feed.notices.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="Latest Notices" icon={SECTIONS.notices.icon} color={SECTIONS.notices.color} />
                <View style={[styles.noticeList, { borderLeftWidth: 4, borderLeftColor: SECTIONS.notices.color }]}>
                  {feed.notices.map((notice, i) => (
                    <TouchableOpacity
                      key={notice.id}
                      style={[styles.noticeRow, i < feed.notices.length - 1 && styles.noticeRowBorder]}
                      activeOpacity={0.8}
                      onPress={() => openUrl(notice.url)}
                    >
                      <View style={[styles.noticeIcon, { backgroundColor: SECTIONS.notices.light }]}>
                        <FontAwesome5 name="bullhorn" size={12} color={SECTIONS.notices.color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.noticeTitle} numberOfLines={1}>{decodeEntities(notice.title)}</Text>
                        <Text style={styles.noticeExcerpt} numberOfLines={2}>{notice.excerpt}</Text>
                      </View>
                      <Text style={styles.noticeDate}>
                        {new Date(notice.posted).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* ── Career vacancies (WP feed) — distinct from native Shifts marketplace ── */}
            {feed.jobs.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="Career vacancies" icon={SECTIONS.jobs.icon} color={SECTIONS.jobs.color} />
                <Text style={styles.sectionSub}>Permanent &amp; contract roles from oneshetland.com · for casual work see Shifts</Text>
                {feed.jobs.map((job) => (
                  <TouchableOpacity
                    key={job.id}
                    style={[styles.jobCard, { borderLeftWidth: 4, borderLeftColor: SECTIONS.jobs.color }]}
                    activeOpacity={0.85}
                    onPress={() => openUrl(job.url)}
                  >
                    {job.image ? (
                      <Image source={{ uri: job.image }} style={styles.jobLogo} />
                    ) : (
                      <View style={[styles.jobLogo, styles.jobLogoPlaceholder, { backgroundColor: SECTIONS.jobs.light }]}>
                        <FontAwesome5 name="building" size={16} color={SECTIONS.jobs.color} />
                      </View>
                    )}
                    <View style={styles.jobBody}>
                      <Text style={styles.jobTitle} numberOfLines={2}>{decodeEntities(job.title)}</Text>
                      {job.company ? <Text style={styles.jobCompany}>{decodeEntities(job.company)}</Text> : null}
                      <View style={styles.jobMeta}>
                        {job.location ? <Text style={styles.jobMetaText}>📍 {job.location}</Text> : null}
                        {job.type ? (
                          <View style={[styles.jobTypePill, { backgroundColor: SECTIONS.jobs.light }]}>
                            <Text style={[styles.jobTypeText, { color: SECTIONS.jobs.color }]}>{job.type}</Text>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}

        {/* ── What's coming — slim strip ── */}
        <View style={styles.comingStrip}>
          <Text style={styles.comingStripTitle}>More coming soon</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.comingStripRow}>
            {[
              SECTIONS.events, SECTIONS.services, SECTIONS.news,
              SECTIONS.cruise, SECTIONS.tourism, SECTIONS.community,
            ].map((s) => (
              <View key={s.label} style={styles.comingChip}>
                <FontAwesome5 name={s.icon as any} size={11} color={s.color} solid />
                <Text style={styles.comingChipText}>{s.label}</Text>
              </View>
            ))}
          </ScrollView>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Text style={styles.footerWordmark}>OneShetland</Text>
          <Text style={styles.footerText}>Everything Shetland, All in One Place</Text>
          <Text style={styles.footerBeta}>Beta · Your feedback helps shape this app</Text>
        </View>

        </View>{/* ── end light sheet ── */}

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.navy },
  content: { paddingBottom: 100 },

  // Light "sheet" that the navy hero band curves into. Rounded top, lifts
  // slightly over the navy so the transition reads as a panel, not a hard line.
  lightSheet: {
    backgroundColor: colors.screenBackground,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    minHeight: 500,
  },

  // ── Hero ──
  hero: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: 8,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroTaglineBlock: { flex: 1 },
  heroRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoWrap: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    padding: 8,
    overflow: 'hidden',
  },
  logo: { width: 36, height: 36 },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  // Wallet-icon circle matching the avatar's visual weight
  headerIconBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  headerIconBadge: {
    position: 'absolute', top: -2, right: -4,
    minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.accent,
    borderWidth: 2, borderColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
  },
  headerIconBadgeText: { color: '#fff', fontSize: 10, fontWeight: '900', lineHeight: 12 },
  avatarText: { color: colors.white, fontSize: fontSize.sm, fontWeight: '700' },

  signInBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full,
  },
  signInBtnText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },

  heroWordmark: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900', lineHeight: 22, letterSpacing: -0.3 },
  heroTagline: { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, lineHeight: 16, marginTop: 1 },
  betaBadge: {
    backgroundColor: colors.accent,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.full,
  },
  betaBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },

  // ── Live section ──
  liveSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  liveSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.md },
  liveSectionTitle: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  livePulse: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#22C55E',
  },
  liveRow: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.lg },
  liveCard: {
    width: 150,
    backgroundColor: colors.navy,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 6,
  },
  liveCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  liveIconWrap: {
    width: 36, height: 36, borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(34,197,94,0.2)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#22C55E' },
  liveBadgeText: { color: '#22C55E', fontSize: 10, fontWeight: '700' },
  liveCardName: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  liveCardDesc: { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, lineHeight: 16 },
  liveCardStat: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700', marginTop: 2 },

  // ── Sections ──
  section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.md },
  sectionAccentBar: { width: 4, height: 20, borderRadius: 2 },
  sectionIconWrap: {
    width: 26, height: 26, borderRadius: radius.xs,
    alignItems: 'center', justifyContent: 'center',
  },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  sectionSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: -6, marginBottom: spacing.sm, lineHeight: 16 },

  // ── For you ──
  forYouSection: { paddingTop: spacing.xl },
  forYouTitle:   { color: '#fff', fontSize: fontSize.md, fontWeight: '800', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  forYouRow:     { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg },
  forYouCard: {
    width: 180, backgroundColor: colors.white, borderRadius: radius.lg,
    padding: spacing.md, gap: 4, borderWidth: 1, borderColor: colors.border,
  },
  forYouIcon:      { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  forYouTag:       { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  forYouCardTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, lineHeight: 18 },
  forYouCardSub:   { fontSize: fontSize.xs, color: colors.textMuted },

  // ── Quick actions ──
  quickSection: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  quickGrid:    { flexDirection: 'row', gap: spacing.sm },
  quickTile: {
    flex: 1, alignItems: 'center', gap: 8,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingVertical: 14, paddingHorizontal: 6,
    borderWidth: 1, borderColor: colors.border,
    // soft lift so the tiles read as pressable surfaces, not flat icons
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 2,
  },
  quickIcon: {
    width: 48, height: 48, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  quickBadge: {
    position: 'absolute', top: -5, right: -5,
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.white,
  },
  quickBadgeText: { color: '#fff', fontSize: 9, fontWeight: '900' },
  quickLabel:     { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', lineHeight: 14 },

  // ── Guess da Wird teaser ──
  wirdTeaser: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: '#0EA5E9', borderRadius: radius.lg, padding: spacing.md,
    shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 4,
  },
  wirdTeaserIcon:  { width: 44, height: 44, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  wirdTeaserTag:   { color: 'rgba(255,255,255,0.8)', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  wirdTeaserTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', marginTop: 2 },
  wirdTeaserSub:   { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, marginTop: 1 },
  wirdTeaserCta:   { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full },
  wirdTeaserCtaText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  // ── Grow your business ──
  growCard: {
    backgroundColor: colors.accent, borderRadius: radius.lg, padding: spacing.lg, gap: 6,
  },
  growDismiss: { position: 'absolute', top: 12, right: 12, zIndex: 2, padding: 4 },
  growIcon:    { width: 40, height: 40, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  growTitle:   { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  growBody:    { color: 'rgba(255,255,255,0.9)', fontSize: fontSize.sm, lineHeight: 20 },
  growCta:     { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.full, marginTop: 6 },
  growCtaText: { color: colors.navy, fontSize: fontSize.sm, fontWeight: '800' },

  // ── Coming strip ──
  comingStrip:      { marginTop: spacing.xl, paddingHorizontal: spacing.lg },
  comingStripTitle: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700', marginBottom: spacing.sm },
  comingStripRow:   { flexDirection: 'row', gap: 8, paddingRight: spacing.lg },
  comingChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.white, borderRadius: radius.full,
    paddingHorizontal: 12, paddingVertical: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  comingChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary ?? colors.textMuted },

  // ── Featured Local offer ──
  featuredOfferCard: {
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 8,
    shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 5,
  },
  featuredOfferTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  featuredOfferDiscount: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.md,
  },
  featuredOfferDiscountText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  featuredOfferTag: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full,
  },
  featuredOfferTagText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  featuredOfferTitle: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900', lineHeight: 24, marginTop: 4 },
  featuredOfferBusiness: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.sm, fontWeight: '600' },
  featuredOfferFooter: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: spacing.sm, paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.2)',
  },
  featuredOfferExpiry: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, fontWeight: '600' },
  featuredOfferCta:    { color: '#fff', fontSize: fontSize.sm, fontWeight: '800', marginLeft: 'auto' },

  // ── Featured Shift (boosted) ──
  featuredShiftCard: {
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 8,
    shadowColor: '#E8A020', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 5,
  },
  featuredShiftTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  featuredShiftBoosted: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.full,
  },
  featuredShiftBoostedText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },
  featuredShiftPay: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.md,
  },
  featuredShiftPayText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
  featuredShiftTitle:    { color: '#fff', fontSize: fontSize.lg, fontWeight: '900', lineHeight: 24, marginTop: 4 },
  featuredShiftBusiness: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, fontWeight: '600' },
  featuredShiftMeta:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  featuredShiftMetaText: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, fontWeight: '600' },
  featuredShiftUrgency:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  featuredShiftUrgencyText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  featuredShiftFooter:   {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: spacing.sm, paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.25)',
  },
  featuredShiftLocation: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, fontWeight: '600', flex: 1 },
  featuredShiftCta:      { color: '#fff', fontSize: fontSize.sm, fontWeight: '800', marginLeft: 'auto' },

  // ── Spik ──
  spikCard: { backgroundColor: colors.navy, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  spikWordRow:    { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  spikWord:       { color: colors.white, fontSize: 26, fontWeight: '800' },
  spikPos:        { color: 'rgba(255,255,255,0.45)', fontSize: fontSize.xs, fontStyle: 'italic' },
  spikDefinition: { color: 'rgba(255,255,255,0.8)', fontSize: fontSize.md, lineHeight: 22 },
  spikExample:    { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.sm, fontStyle: 'italic', lineHeight: 20 },
  spikCategoryPill: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12, paddingHorizontal: spacing.sm, paddingVertical: 4, marginTop: spacing.xs },
  spikCategoryText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, textTransform: 'capitalize' },
  spikFooter: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.xs, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.15)' },
  spikFooterText: { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '600' },

  // ── Events ──
  eventCard: { flexDirection: 'row', backgroundColor: colors.white, borderRadius: radius.lg, marginBottom: spacing.sm, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  eventImage: { width: 90, height: 90 },
  eventImagePlaceholder: { backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  eventBody: { flex: 1, padding: spacing.md, justifyContent: 'center', gap: 4 },
  eventDatePill: { alignSelf: 'flex-start', backgroundColor: '#EEF4FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginBottom: 4 },
  eventDateText: { color: colors.navy, fontSize: fontSize.xs, fontWeight: '700' },
  eventTitle:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, lineHeight: 18 },
  eventVenue:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  // ── Notices ──
  noticeList: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', padding: spacing.md, gap: spacing.sm },
  noticeRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  noticeIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#EEF4FF', alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  noticeTitle:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  noticeExcerpt: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  noticeDate:    { fontSize: fontSize.xs, color: colors.textLight, marginTop: 2 },

  // ── Jobs ──
  jobCard: { flexDirection: 'row', backgroundColor: colors.white, borderRadius: radius.lg, marginBottom: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, gap: spacing.md, alignItems: 'flex-start' },
  jobLogo: { width: 44, height: 44, borderRadius: radius.sm },
  jobLogoPlaceholder: { backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  jobBody:    { flex: 1, gap: 3 },
  jobTitle:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, lineHeight: 18 },
  jobCompany: { fontSize: fontSize.xs, color: colors.textMuted },
  jobMeta:    { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4, flexWrap: 'wrap' },
  jobMetaText:  { fontSize: fontSize.xs, color: colors.textMuted },
  jobTypePill:  { backgroundColor: '#EEF4FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  jobTypeText:  { fontSize: fontSize.xs, color: colors.navy, fontWeight: '600' },

  // ── Coming ──
  comingSection: {
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    backgroundColor: colors.navy,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  comingSectionTitle: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900', marginBottom: 6 },
  comingSectionSub:   { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.lg },
  comingGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  comingCard: {
    width: '47%',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    // borderLeftWidth and borderLeftColor set inline per card
  },
  comingIconWrap: {
    width: 30, height: 30, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 2,
  },
  comingName: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, fontWeight: '700' },
  comingDesc: { color: 'rgba(255,255,255,0.4)', fontSize: fontSize.xs, lineHeight: 16 },

  // ── Footer ──
  footer: { padding: spacing.xl, alignItems: 'center', gap: 4 },
  footerWordmark: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '900' },
  footerText:     { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center' },
  footerBeta:     { fontSize: fontSize.xs, color: colors.textLight, textAlign: 'center', marginTop: 4 },

  // ── Loading / Error ──
  loadingWrap: { padding: spacing.xl, alignItems: 'center' },
  errorBox: { margin: spacing.lg, backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: spacing.md, alignItems: 'center', gap: spacing.sm },
  errorText:  { color: '#DC2626', fontSize: fontSize.sm, textAlign: 'center' },
  retryText:  { color: colors.navy, fontSize: fontSize.sm, fontWeight: '700', textDecorationLine: 'underline' },
});
