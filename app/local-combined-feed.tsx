/**
 * Local combined feed — events carousel, business grid, jobs, notices.
 * Designed to feel like a living local magazine, not a data table.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl, useWindowDimensions,
  ImageBackground,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import {
  fetchLocalFeed, fetchActiveOffersForBusinesses, formatOfferDiscount, formatValidUntil,
  isBusinessFeatured, SHETLAND_AREAS,
  type LocalBusiness, type LocalFeedEvent, type LocalFeedJob, type LocalOffer,
} from '@/lib/local-api';
import { fetchPublicNotices, type HubNotice } from '@/lib/hubs-api';
import { isBookableLive } from '@/lib/book-api';

const S = SECTIONS.local;
const EVENTS_COLOR  = '#d4921a';
const JOBS_COLOR    = '#0ea5e9';
const NOTICES_COLOR = '#10b981';

const EVENT_FALLBACK_GRADIENTS: [string, string][] = [
  ['#d4921a', '#b87317'],
  ['#7c3aed', '#5b21b6'],
  ['#0ea5e9', '#0369a1'],
  ['#10b981', '#047857'],
  ['#ef4444', '#b91c1c'],
];

const CATEGORY_EMOJI: Record<string, string> = {
  food_drink: '🍽', retail: '🛍', services: '🔧',
  tourism: '🌅', accommodation: '🛏', other: '📍',
};
const CATEGORY_LABEL: Record<string, string> = {
  food_drink: 'Food & Drink', retail: 'Retail', services: 'Services',
  tourism: 'Tourism', accommodation: 'Accommodation', other: 'Other',
};
const CATEGORY_COLOR: Record<string, string> = {
  food_drink: '#d4921a', retail: '#7c3aed', services: '#0ea5e9',
  tourism: '#10b981', accommodation: '#ef4444', other: '#6b7280',
};

type AreaKey = typeof SHETLAND_AREAS[number]['key'] | '';

export default function LocalCombinedFeed() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const [area, setArea]             = useState<AreaKey>('');
  const [events, setEvents]         = useState<LocalFeedEvent[]>([]);
  const [businesses, setBusinesses] = useState<LocalBusiness[]>([]);
  const [jobs, setJobs]             = useState<LocalFeedJob[]>([]);
  const [notices, setNotices]       = useState<HubNotice[]>([]);
  const [offersMap, setOffersMap]   = useState<Map<string, LocalOffer>>(new Map());
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (a: AreaKey) => {
    try {
      const [feed, pub] = await Promise.all([
        fetchLocalFeed(a || undefined),
        fetchPublicNotices(6),
      ]);
      setEvents(feed.events);
      setBusinesses(feed.businesses);
      setJobs(feed.jobs);
      setNotices(pub);
      // Fetch live offers for every business in the feed, build id→offer map (first offer wins)
      const offers = await fetchActiveOffersForBusinesses(feed.businesses.map(b => b.id));
      const map = new Map<string, LocalOffer>();
      for (const o of offers) {
        if (!map.has(o.business_id)) map.set(o.business_id, o);
      }
      setOffersMap(map);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(area); }, [area, load]);

  const areaLabel = SHETLAND_AREAS.find(a => a.key === area)?.label;

  // Always pair businesses into 2-col grid rows
  const bizRows: LocalBusiness[][] = [];
  for (let i = 0; i < businesses.length; i += 2) bizRows.push(businesses.slice(i, i + 2));

  // Derived highlights — built from already-loaded data, no extra fetch
  const activeOffers = businesses
    .filter(b => offersMap.has(b.id))
    .map(b => ({ business: b, offer: offersMap.get(b.id)! }));
  const bookableBusinesses = businesses.filter(b => isBookableLive(b));

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <View>
        <TabScreenHeader
          section={S}
          photo={SECTION_HEROES.local}
          title="Local"
          eyebrow={areaLabel ?? 'All Shetland'}
        />
        {router.canGoBack() && (
          <View style={{ position: 'absolute', top: 12, left: spacing.md }}>
            <HeroBackPill variant="overlay" label="Back" onPress={() => router.back()} />
          </View>
        )}
      </View>

      {/* Area filter */}
      <View style={styles.filterBar}>
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterContent}
          alwaysBounceHorizontal={false}
        >
          <AreaChip active={area === ''} label="All Shetland" onPress={() => { Haptics.selectionAsync(); setArea(''); }} />
          {SHETLAND_AREAS.map(a => (
            <AreaChip key={a.key} active={area === a.key} label={a.label}
              onPress={() => { Haptics.selectionAsync(); setArea(a.key as AreaKey); }} />
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(area); }} tintColor={S.color} />}
          showsVerticalScrollIndicator={false}
        >
          {/* CURATED SHORTCUTS — Local leads with offers / bookable / wallet,
              not a generic business list (that's the Directory tab). */}
          <View style={styles.shortcutRow}>
            <ShortcutCard
              icon="tags" label="Offers" sub="Deals & savings"
              color="#D97706" bg="#FEF3C7"
              onPress={() => { Haptics.selectionAsync(); router.push('/local-offers' as any); }}
            />
            <ShortcutCard
              icon="calendar-check" label="Book" sub="Experiences"
              color="#059669" bg="#D1FAE5"
              onPress={() => { Haptics.selectionAsync(); router.push('/local-bookable-browse' as any); }}
            />
            <ShortcutCard
              icon="wallet" label="Wallet" sub="Cashback"
              color={S.color} bg={S.light}
              onPress={() => { Haptics.selectionAsync(); router.push('/local-wallet' as any); }}
            />
          </View>

          {/* SHOP LOCAL SHETLAND — the island-wide loyalty hub (flagship of Local) */}
          <TouchableOpacity
            style={[styles.loyaltyBanner, { backgroundColor: S.color }]}
            activeOpacity={0.9}
            onPress={() => { Haptics.selectionAsync(); router.push('/local-loyalty-hub' as any); }}
          >
            <View style={styles.loyaltyIcon}>
              <FontAwesome5 name="star" size={18} color="#fff" solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.loyaltyTitle}>Shop Local Shetland</Text>
              <Text style={styles.loyaltySub}>One card for every shop — stamps, points & deals across the isles</Text>
            </View>
            <FontAwesome5 name="chevron-right" size={13} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>

          {/* EVENTS */}
          <SectionHeader label={areaLabel ? `Events in ${areaLabel}` : "What's on"} title="Upcoming events"
            color={EVENTS_COLOR} onSeeAll={() => router.push('/(tabs)/whats-on' as any)} />
          {events.length === 0 ? (
            <EmptyCard icon="📅" message="No upcoming events — check back soon." />
          ) : (
            <FlatList
              horizontal data={events} keyExtractor={e => e.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.carousel}
              snapToInterval={isTablet ? 302 : 242}
              decelerationRate="fast"
              renderItem={({ item: ev, index }) => (
                <EventCard event={ev} index={index} cardWidth={isTablet ? 290 : 230}
                  onPress={() => router.push({ pathname: '/events/[id]', params: { id: ev.id } })} />
              )}
            />
          )}

          {/* OFFERS & DEALS */}
          {activeOffers.length > 0 && (
            <>
              <SectionHeader label="Exclusive savings" title="Offers & deals"
                color="#D97706" onSeeAll={() => router.push('/local-offers' as any)} />
              <FlatList
                horizontal data={activeOffers} keyExtractor={o => o.offer.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carousel}
                snapToInterval={isTablet ? 302 : 242}
                decelerationRate="fast"
                renderItem={({ item: { business, offer } }) => (
                  <OfferCard
                    business={business} offer={offer}
                    cardWidth={isTablet ? 290 : 230}
                    onPress={() => router.push({ pathname: '/local-business-detail', params: { id: business.id } })}
                  />
                )}
              />
            </>
          )}

          {/* BOOK NOW */}
          {bookableBusinesses.length > 0 && (
            <>
              <SectionHeader label="Reserve your spot" title="Book now"
                color="#059669" onSeeAll={() => router.push('/local-bookable-browse' as any)} />
              <FlatList
                horizontal data={bookableBusinesses} keyExtractor={b => b.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carousel}
                snapToInterval={172}
                decelerationRate="fast"
                renderItem={({ item: b }) => (
                  <BookNowCard
                    business={b}
                    onPress={() => router.push({ pathname: '/local-business-detail', params: { id: b.id } })}
                  />
                )}
              />
            </>
          )}

          {/* BUSINESSES */}
          <SectionHeader label={areaLabel ? `In ${areaLabel}` : 'Shetland makers & shops'} title="Open for business"
            color={S.color} onSeeAll={() => router.push('/(tabs)/services' as any)} />
          {businesses.length === 0 ? (
            <EmptyCard icon="🏪" message="No businesses listed yet — be the first to add yours." />
          ) : (
            <View style={styles.padded}>
              {bizRows.map((pair, i) => (
                <View key={i} style={[styles.gridRow, { marginBottom: 12 }]}>
                  {pair.map(b => (
                    <BusinessTile key={b.id} business={b} offer={offersMap.get(b.id)}
                      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: b.id } })} />
                  ))}
                  {pair.length === 1 && <View style={{ flex: 1 }} />}
                </View>
              ))}
            </View>
          )}

          {/* JOBS */}
          {jobs.length > 0 && (
            <>
              <SectionHeader label={areaLabel ? `Work in ${areaLabel}` : 'Opportunities'} title="Jobs & shifts"
                color={JOBS_COLOR} onSeeAll={() => router.push('/(tabs)/jobs' as any)} />
              <View style={styles.padded}>
                {jobs.map(j => (
                  <JobCard key={j.id} job={j} onPress={() => router.push(`/job/${j.id}` as any)} />
                ))}
              </View>
            </>
          )}

          {/* NOTICES */}
          {notices.length > 0 && (
            <>
              <SectionHeader label="Community" title="Hub notices"
                color={NOTICES_COLOR} onSeeAll={() => router.push('/hubs' as any)} />
              <View style={[styles.padded, isTablet && styles.noticeGrid]}>
                {notices.map(n => (
                  <NoticeCard key={n.id} notice={n}
                    style={isTablet ? { flex: 1, minWidth: 0 } : undefined}
                    onPress={() => n.hub && router.push({ pathname: '/hubs/[id]', params: { id: n.hub!.id } })} />
                ))}
              </View>
            </>
          )}

          <View style={{ height: 80 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, title, color, onSeeAll }: {
  label: string; title: string; color: string; onSeeAll: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionAccent, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.sectionLabel, { color }]}>{label.toUpperCase()}</Text>
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      <TouchableOpacity style={[styles.seeAllBtn, { borderColor: color + '50' }]} onPress={onSeeAll} activeOpacity={0.7}>
        <Text style={[styles.seeAllText, { color }]}>See all</Text>
        <FontAwesome5 name="arrow-right" size={10} color={color} />
      </TouchableOpacity>
    </View>
  );
}

// ── Curated shortcut card ─────────────────────────────────────────────────────

function ShortcutCard({ icon, label, sub, color, bg, onPress }: {
  icon: string; label: string; sub: string; color: string; bg: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.shortcutCard} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.shortcutIcon, { backgroundColor: bg }]}>
        <FontAwesome5 name={icon} size={16} color={color} solid />
      </View>
      <Text style={styles.shortcutLabel}>{label}</Text>
      <Text style={styles.shortcutSub} numberOfLines={1}>{sub}</Text>
    </TouchableOpacity>
  );
}

// ── Area chip ─────────────────────────────────────────────────────────────────

function AreaChip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && { backgroundColor: S.color, borderColor: S.color }]}
      onPress={onPress} activeOpacity={0.75}
    >
      <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Event card (carousel) ─────────────────────────────────────────────────────

function EventCard({ event, index, cardWidth, onPress }: {
  event: LocalFeedEvent; index: number; cardWidth: number; onPress: () => void;
}) {
  const d = new Date(event.starts_at);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric' });
  const mon = d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const [g1, g2] = EVENT_FALLBACK_GRADIENTS[index % EVENT_FALLBACK_GRADIENTS.length];

  return (
    <TouchableOpacity style={[styles.eventCard, { width: cardWidth }]} onPress={onPress} activeOpacity={0.9}>
      <View style={styles.eventImg}>
        {event.cover_url ? (
          <>
            <ImageBackground source={{ uri: event.cover_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            {/* Dark scrim so date/title stay readable over images */}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.30)' }]} />
          </>
        ) : (
          /* Solid brand colour when no cover image */
          <View style={[StyleSheet.absoluteFill, { backgroundColor: g1 }]} />
        )}
        {/* Date */}
        <View style={styles.dateBadge}>
          <Text style={styles.dateMon}>{mon}</Text>
          <Text style={styles.dateDay}>{day}</Text>
        </View>
        {/* Ticket */}
        {event.has_tickets && (
          <View style={styles.ticketBadge}>
            <FontAwesome5 name="ticket-alt" size={8} color={EVENTS_COLOR} solid />
            <Text style={styles.ticketText}>Get tickets</Text>
          </View>
        )}
      </View>
      <View style={styles.eventBody}>
        <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.eventMeta}>{time}{event.venue ? ` · ${event.venue}` : ''}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Offer card ────────────────────────────────────────────────────────────────

function OfferCard({ business, offer, cardWidth, onPress }: {
  business: LocalBusiness; offer: LocalOffer; cardWidth: number; onPress: () => void;
}) {
  const cat      = business.category ?? 'other';
  const catColor = CATEGORY_COLOR[cat] ?? '#6b7280';
  const emoji    = CATEGORY_EMOJI[cat] ?? '🏪';
  const coverUri = offer.image_url ?? business.cover_url ?? null;
  const discount = formatOfferDiscount(offer);

  return (
    <TouchableOpacity style={[styles.offerCard, { width: cardWidth }]} onPress={onPress} activeOpacity={0.85}>
      {/* Cover */}
      {coverUri ? (
        <Image source={{ uri: coverUri }} style={styles.offerCardImage} />
      ) : (
        <View style={[styles.offerCardPlaceholder, { backgroundColor: catColor + '18' }]}>
          <Text style={styles.offerCardEmoji}>{emoji}</Text>
        </View>
      )}

      {/* Discount badge — mirrors date badge on event cards */}
      <View style={styles.discountBadge}>
        <FontAwesome5 name="tag" size={9} color="#D97706" solid />
        <Text style={styles.discountBadgeText}>{discount}</Text>
      </View>

      {/* Card body */}
      <View style={styles.offerCardBody}>
        {/* Business logo pill */}
        <View style={[styles.bizLogoPill, { backgroundColor: catColor + '18' }]}>
          {business.logo_url
            ? <Image source={{ uri: business.logo_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            : <Text style={{ fontSize: 16 }}>{emoji}</Text>}
        </View>
        <View style={styles.bizMeta}>
          <Text style={[styles.bizCategory, { color: catColor }]}>{CATEGORY_LABEL[cat] ?? cat}</Text>
          <Text style={styles.offerCardTitle} numberOfLines={2}>{offer.title}</Text>
          <Text style={styles.offerCardBusiness} numberOfLines={1}>{business.name}</Text>
          <Text style={styles.offerCardExpiry}>Until {formatValidUntil(offer.valid_until)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── Book now card ─────────────────────────────────────────────────────────────

function BookNowCard({ business, onPress }: { business: LocalBusiness; onPress: () => void }) {
  const cat      = business.category ?? 'other';
  const catColor = CATEGORY_COLOR[cat] ?? '#6b7280';
  const emoji    = CATEGORY_EMOJI[cat] ?? '🏪';

  return (
    <TouchableOpacity style={styles.bookCard} onPress={onPress} activeOpacity={0.85}>
      {/* Cover or placeholder */}
      {business.cover_url ? (
        <Image source={{ uri: business.cover_url }} style={styles.bookCardImage} />
      ) : (
        <View style={[styles.bookCardPlaceholder, { backgroundColor: catColor + '18' }]}>
          <Text style={{ fontSize: 36, opacity: 0.4 }}>{emoji}</Text>
        </View>
      )}

      <View style={styles.bookCardBody}>
        <View style={[styles.bizLogoPill, { backgroundColor: catColor + '18', width: 34, height: 34 }]}>
          {business.logo_url
            ? <Image source={{ uri: business.logo_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            : <Text style={{ fontSize: 16 }}>{emoji}</Text>}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.bizCategory, { color: catColor }]}>{CATEGORY_LABEL[cat] ?? cat}</Text>
          <Text style={styles.bookCardName} numberOfLines={2}>{business.name}</Text>
        </View>
      </View>

      <View style={styles.bookCardFooter}>
        <FontAwesome5 name="calendar-check" size={10} color="#fff" solid />
        <Text style={styles.bookCardBtn}>Book now</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Business tile — EventCard style ──────────────────────────────────────────

function BusinessTile({ business, offer, onPress }: {
  business: LocalBusiness; offer?: LocalOffer; onPress: () => void;
}) {
  const router   = useRouter();
  const cat      = business.category ?? 'other';
  const catColor = CATEGORY_COLOR[cat] ?? '#6b7280';
  const emoji    = CATEGORY_EMOJI[cat] ?? '🏪';
  const featured = isBusinessFeatured(business);

  return (
    <TouchableOpacity style={styles.bizCard} onPress={onPress} activeOpacity={0.85}>
      {/* Cover image or colour placeholder */}
      {business.cover_url ? (
        <Image source={{ uri: business.cover_url }} style={styles.bizCardImage} />
      ) : (
        <View style={[styles.bizCardPlaceholder, { backgroundColor: catColor + '18' }]}>
          <Text style={styles.bizCardEmoji}>{emoji}</Text>
        </View>
      )}

      {/* Featured badge */}
      {featured && (
        <View style={styles.bizFeaturedBadge}>
          <FontAwesome5 name="star" size={9} color="#fff" solid />
          <Text style={styles.bizFeaturedText}>Featured</Text>
        </View>
      )}

      {/* Card body: logo pill + meta (mirrors EventCard exactly) */}
      <View style={styles.bizCardBody}>
        {/* Logo pill */}
        <View style={[styles.bizLogoPill, { backgroundColor: catColor + '18' }]}>
          {business.logo_url
            ? <Image source={{ uri: business.logo_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            : <Text style={{ fontSize: 18 }}>{emoji}</Text>}
          {business.is_verified && (
            <View style={[styles.bizVerifiedDot, { backgroundColor: catColor }]}>
              <FontAwesome5 name="check" size={6} color="#fff" solid />
            </View>
          )}
        </View>

        {/* Meta */}
        <View style={styles.bizMeta}>
          <Text style={[styles.bizCategory, { color: catColor }]}>
            {CATEGORY_LABEL[cat] ?? cat}
          </Text>
          <Text style={styles.bizName} numberOfLines={2}>{business.name}</Text>
          {business.address ? (
            <View style={styles.bizInfoRow}>
              <FontAwesome5 name="map-marker-alt" size={9} color={colors.textMuted} />
              <Text style={styles.bizInfoText} numberOfLines={1}>{business.address}</Text>
            </View>
          ) : null}
          <View style={styles.bizFootRow}>
            {isBookableLive(business) && (
              <View style={[styles.bizMiniPill, { backgroundColor: '#D1FAE5' }]}>
                <Text style={[styles.bizMiniPillText, { color: '#059669' }]}>📅 Book</Text>
              </View>
            )}
            {(business.cashback_percent ?? 0) > 0 && (
              <View style={[styles.bizMiniPill, { backgroundColor: '#FEF3C7' }]}>
                <Text style={[styles.bizMiniPillText, { color: '#D97706' }]}>{business.cashback_percent}% back</Text>
              </View>
            )}
            {business.accepts_wallet && (
              <View style={[styles.bizMiniPill, { backgroundColor: catColor + '18' }]}>
                <Text style={[styles.bizMiniPillText, { color: catColor }]}>👛</Text>
              </View>
            )}
            {offer && (
              <View style={styles.bizOfferPill}>
                <Text style={styles.bizOfferPillText}>{formatOfferDiscount(offer)}</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Offer strip at bottom */}
      {offer && (
        <View style={styles.bizOfferStrip}>
          <FontAwesome5 name="tag" size={9} color="#D97706" />
          <Text style={styles.bizOfferTitle} numberOfLines={1}>{offer.title}</Text>
          <Text style={styles.bizOfferExpiry}>Until {formatValidUntil(offer.valid_until)}</Text>
        </View>
      )}

      {/* Claim strip */}
      {!business.is_claimed && (
        <TouchableOpacity
          style={styles.bizClaimStrip}
          onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/business-claim', params: { id: business.id } }); }}
          activeOpacity={0.75}
        >
          <FontAwesome5 name="store" size={9} color="#6366F1" />
          <Text style={styles.bizClaimText}>Claim this listing <Text style={styles.bizClaimLink}>→</Text></Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

// ── Job card ──────────────────────────────────────────────────────────────────

function JobCard({ job, onPress }: { job: LocalFeedJob; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.jobCard} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.jobIcon, { backgroundColor: JOBS_COLOR + '18' }]}>
        <FontAwesome5 name="briefcase" size={14} color={JOBS_COLOR} solid />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.jobTitle} numberOfLines={1}>{job.title}</Text>
        {job.location && <Text style={styles.jobLoc}>{job.location}</Text>}
      </View>
      {job.pay_text
        ? <View style={[styles.payPill, { backgroundColor: JOBS_COLOR + '18' }]}>
            <Text style={[styles.payText, { color: JOBS_COLOR }]}>{job.pay_text}</Text>
          </View>
        : <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />}
    </TouchableOpacity>
  );
}

// ── Notice card ───────────────────────────────────────────────────────────────

function NoticeCard({ notice, style, onPress }: {
  notice: HubNotice; style?: object; onPress: () => void;
}) {
  const hub = notice.hub ?? null;
  return (
    <TouchableOpacity style={[styles.noticeCard, style]} onPress={onPress} activeOpacity={0.85} disabled={!hub}>
      {hub && (
        <View style={styles.noticeHub}>
          <View style={styles.hubLogo}>
            {hub.logo_url
              ? <Image source={{ uri: hub.logo_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              : <Text style={styles.hubInitial}>{hub.name.slice(0, 1)}</Text>}
          </View>
          <Text style={styles.hubName} numberOfLines={1}>{hub.name}</Text>
          <View style={[styles.noticeDot, { backgroundColor: NOTICES_COLOR }]} />
        </View>
      )}
      <Text style={styles.noticeTitle} numberOfLines={2}>{notice.title}</Text>
      {notice.body && <Text style={styles.noticeBody} numberOfLines={3}>{notice.body}</Text>}
    </TouchableOpacity>
  );
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function EmptyCard({ icon, message }: { icon: string; message: string }) {
  return (
    <View style={styles.emptyCard}>
      <Text style={{ fontSize: 32 }}>{icon}</Text>
      <Text style={styles.emptyMsg}>{message}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { backgroundColor: colors.screenBackground },
  padded: { paddingHorizontal: spacing.md },

  filterBar:    { backgroundColor: colors.screenBackground, borderBottomWidth: 1, borderBottomColor: colors.border },
  filterContent:{ paddingHorizontal: spacing.md, paddingVertical: 10, gap: 8, flexDirection: 'row', alignItems: 'center' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 7,
    backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
  },
  chipText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },

  shortcutRow: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: spacing.md, paddingTop: 16,
  },
  loyaltyBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: spacing.md, marginTop: 12,
    borderRadius: radius.lg, padding: 14,
  },
  loyaltyIcon: {
    width: 42, height: 42, borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center',
  },
  loyaltyTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  loyaltySub: { color: 'rgba(255,255,255,0.9)', fontSize: fontSize.xs, marginTop: 2, lineHeight: 15 },
  shortcutCard: {
    flex: 1, backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 14, paddingHorizontal: 10, alignItems: 'center', gap: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 1,
  },
  shortcutIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  shortcutLabel: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
  shortcutSub:   { fontSize: 10, color: colors.textMuted, fontWeight: '600' },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginTop: 28, marginBottom: 14, paddingHorizontal: spacing.md,
  },
  sectionAccent: { width: 4, height: 38, borderRadius: 2 },
  sectionLabel:  { fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  sectionTitle:  { fontSize: 21, fontWeight: '900', color: colors.textPrimary, marginTop: 1 },
  seeAllBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.full, borderWidth: 1.5 },
  seeAllText:    { fontSize: 12, fontWeight: '700' },

  carousel: { paddingHorizontal: spacing.md, gap: 12, paddingBottom: 4 },

  // Event card
  eventCard: {
    borderRadius: 18, overflow: 'hidden', backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.13, shadowRadius: 10, elevation: 4,
  },
  eventImg:    { height: 170, position: 'relative' },
  dateBadge:   {
    position: 'absolute', top: 10, left: 10,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5,
    alignItems: 'center', minWidth: 40,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 3,
  },
  dateMon:     { fontSize: 9, fontWeight: '900', color: EVENTS_COLOR, letterSpacing: 1 },
  dateDay:     { fontSize: 22, fontWeight: '900', color: colors.textPrimary, lineHeight: 24 },
  ticketBadge: {
    position: 'absolute', bottom: 10, right: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.95)',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full,
  },
  ticketText:  { fontSize: 10, fontWeight: '800', color: EVENTS_COLOR },
  eventBody:   { padding: 14 },
  eventTitle:  { fontSize: 15, fontWeight: '800', color: colors.textPrimary, lineHeight: 20 },
  eventMeta:   { fontSize: 12, color: colors.textMuted, marginTop: 5, fontWeight: '600' },

  // Offer card
  offerCard: {
    backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
  },
  offerCardImage:       { width: '100%', height: 140, resizeMode: 'cover' },
  offerCardPlaceholder: { width: '100%', height: 110, alignItems: 'center', justifyContent: 'center' },
  offerCardEmoji:       { fontSize: 50, opacity: 0.3 },
  discountBadge: {
    position: 'absolute', top: 10, left: 10,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.12, shadowRadius: 3,
  },
  discountBadgeText: { fontSize: 13, fontWeight: '900', color: '#D97706' },
  offerCardBody:     { flexDirection: 'row', gap: 8, padding: 10, paddingTop: 8 },
  offerCardTitle:    { fontSize: 12, fontWeight: '800', color: colors.textPrimary, lineHeight: 16, marginTop: 1 },
  offerCardBusiness: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  offerCardExpiry:   { fontSize: 9, color: '#B45309', marginTop: 3 },

  // Book now card
  bookCard: {
    width: 160, backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
  },
  bookCardImage:       { width: '100%', height: 90, resizeMode: 'cover' },
  bookCardPlaceholder: { width: '100%', height: 70, alignItems: 'center', justifyContent: 'center' },
  bookCardBody:        { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, paddingBottom: 6 },
  bookCardName:        { fontSize: 12, fontWeight: '800', color: colors.textPrimary, lineHeight: 15 },
  bookCardFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: '#059669', paddingVertical: 8, marginHorizontal: 10, marginBottom: 10, borderRadius: radius.full,
  },
  bookCardBtn: { fontSize: 11, fontWeight: '800', color: '#fff' },

  // Business tile — EventCard style
  bizCard: {
    flex: 1, backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
  },
  bizCardImage:       { width: '100%', height: 120, resizeMode: 'cover' },
  bizCardPlaceholder: { width: '100%', height: 90, alignItems: 'center', justifyContent: 'center' },
  bizCardEmoji:       { fontSize: 44, opacity: 0.3 },
  bizFeaturedBadge: {
    position: 'absolute', top: 8, right: 8,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: S.color, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full,
  },
  bizFeaturedText: { fontSize: 9, fontWeight: '800', color: '#fff' },
  bizCardBody:     { flexDirection: 'row', gap: 8, padding: 10, paddingTop: 8 },
  bizLogoPill: {
    width: 38, height: 38, borderRadius: radius.md, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0, alignSelf: 'flex-start', position: 'relative',
  },
  bizVerifiedDot: {
    position: 'absolute', bottom: -2, right: -2,
    width: 14, height: 14, borderRadius: 7,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
  },
  bizMeta:     { flex: 1, gap: 2 },
  bizCategory: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  bizName:     { fontSize: 12, fontWeight: '800', color: colors.textPrimary, lineHeight: 16 },
  bizInfoRow:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  bizInfoText: { fontSize: 10, color: colors.textMuted, flex: 1 },
  bizFootRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  bizMiniPill: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: radius.full },
  bizMiniPillText: { fontSize: 9, fontWeight: '700' },
  bizOfferPill:     { backgroundColor: '#F59E0B', borderRadius: radius.full, paddingHorizontal: 6, paddingVertical: 2 },
  bizOfferPillText: { fontSize: 9, fontWeight: '900', color: '#fff' },
  bizOfferStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FFFBEB', paddingHorizontal: 10, paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: '#FDE68A',
  },
  bizOfferTitle:  { fontSize: 10, fontWeight: '700', color: '#92400E', flex: 1 },
  bizOfferExpiry: { fontSize: 9, color: '#B45309' },

  bizClaimStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#EEF2FF', paddingHorizontal: 10, paddingVertical: 5,
    borderTopWidth: 1, borderTopColor: '#C7D2FE',
  },
  bizClaimText: { fontSize: 10, color: '#4338CA' },
  bizClaimLink: { fontWeight: '800' },

  gridRow:     { flexDirection: 'row', gap: 10 },
  noticeGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },

  // Job
  jobCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 1,
  },
  jobIcon:  { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  jobTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  jobLoc:   { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  payPill:  { borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  payText:  { fontSize: 11, fontWeight: '700' },

  // Notice
  noticeCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
    borderLeftWidth: 3, borderLeftColor: NOTICES_COLOR,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 1,
  },
  noticeHub:   { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  hubLogo:     { width: 22, height: 22, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  hubInitial:  { fontSize: 11, fontWeight: '800', color: colors.textMuted },
  hubName:     { fontSize: 11, fontWeight: '700', color: colors.textMuted, flex: 1 },
  noticeDot:   { width: 7, height: 7, borderRadius: 4 },
  noticeTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary, lineHeight: 19 },
  noticeBody:  { fontSize: 12, color: colors.textMuted, marginTop: 5, lineHeight: 17 },

  // Empty
  emptyCard: {
    marginHorizontal: spacing.md, borderRadius: 16,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border,
    borderStyle: 'dashed', paddingVertical: 28, alignItems: 'center', gap: 6,
  },
  emptyMsg:  { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 24 },
});
