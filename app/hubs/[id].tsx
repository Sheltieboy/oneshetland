/**
 * hubs/[id].tsx
 * Public Hub page: branding, overview, contact, Join, notices (public +
 * member-only for members), and admin entry points for committee/owners.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStripe } from '@stripe/stripe-react-native';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import { useAuth } from '@/context/AuthContext';
import { ConfirmPaymentSheet } from '@/components/ConfirmPaymentSheet';
import { fetchWalletBalance, walletCheckout } from '@/lib/local-api';
import { useAttemptId } from '@/hooks/useAttemptId';
import {
  fetchHub, fetchMyMembership, joinHub, leaveHub, fetchMemberCount, fetchHubNotices,
  fetchHubMembershipTypes, startHubMembershipPayment, confirmHubMembership,
  fetchHubDocuments, fetchActiveCampaign,
  formatMembershipPrice, HUB_MEMBERSHIP_FEE_PENCE,
  HUB_TYPE_LABELS, HUB_TYPE_ICONS,
  type Hub, type HubMember, type HubNotice, type HubMembershipType, type HubDocument, type HubCampaign, campaignAcceptsDonations } from '@/lib/hubs-api';
import { fetchHubEvents, type OsEvent } from '@/lib/events-api';
import { FundraisingProgress } from '@/components/FundraisingProgress';
import { ContentActions } from '@/components/ContentActions';
import { useAlert } from '@/components/BrandedAlert';
import { track } from '@/lib/analytics';

const S = SECTIONS.community;

function tint(hex?: string | null): string | null {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return null;
  return hex.startsWith('#') ? hex : `#${hex}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function HubDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const goToSignIn = useGoToSignIn();
  const { profile } = useAuth();
  const { isTablet, contentWidth } = useAppLayout();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { alert } = useAlert();

  const [hub, setHub] = useState<Hub | null>(null);
  const [membership, setMembership] = useState<HubMember | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [notices, setNotices] = useState<HubNotice[]>([]);
  const [docs, setDocs] = useState<HubDocument[]>([]);
  const [campaign, setCampaign] = useState<HubCampaign | null>(null);
  const [events, setEvents] = useState<OsEvent[]>([]);
  const [types, setTypes] = useState<HubMembershipType[]>([]);
  const [payingType, setPayingType] = useState<HubMembershipType | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  // One reference per deliberate membership checkout. Keyed on a session rather
  // than the tier, because RENEWING is buying the same tier again and would
  // otherwise reuse the original join's reference — and its PaymentIntent.
  // Bumped when a checkout finishes, after any SCA, and on failure too.
  const [memberSession, setMemberSession] = useState(0);
  const memberAttempt = useAttemptId(memberSession);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  // In-page success state. This screen isn't a dedicated modal, and a Modal-based
  // alert (the app-root BrandedAlert) can't present over a modal — and we mustn't
  // introduce another Modal here — so success is shown as an in-page banner.
  const [joinSuccess, setJoinSuccess] = useState<{ title: string; message: string } | null>(null);
  const attemptId = useAttemptId(payingType?.id ?? null);   // one reference per tier

  useEffect(() => { if (profile?.id) fetchWalletBalance(profile.id).then(setWalletBalance).catch(() => {}); }, [profile?.id]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, mem, count, nts, tps, dcs, cmp, evs] = await Promise.all([
        fetchHub(id),
        profile ? fetchMyMembership(id, profile.id) : Promise.resolve(null),
        fetchMemberCount(id),
        fetchHubNotices(id),
        fetchHubMembershipTypes(id),
        fetchHubDocuments(id).catch(() => [] as HubDocument[]),
        fetchActiveCampaign(id).catch(() => null),
        fetchHubEvents(id).catch(() => [] as OsEvent[]),
      ]);
      setHub(h); setMembership(mem); setMemberCount(count); setNotices(nts); setTypes(tps); setDocs(dcs); setCampaign(cmp); setEvents(evs);
    } finally { setLoading(false); }
  }, [id, profile?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (hub?.id) track('content_viewed', { objectType: 'hub', objectId: hub.id, hubId: hub.id });
  }, [hub?.id]);

  const accent = tint(hub?.brand_color) ?? S.color;
  const isAdmin   = membership?.status === 'active' && (membership.role === 'owner' || membership.role === 'committee');
  const isExpired = !isAdmin && membership?.status === 'active' && !!membership?.paid_until && new Date(membership.paid_until) <= new Date();
  const isMember  = membership?.status === 'active' && !isExpired;
  const isPending = membership?.status === 'pending';
  const myType = membership?.membership_type_id ? types.find(t => t.id === membership.membership_type_id) ?? null : null;

  // Free join — optionally records the chosen free tier.
  const onJoinFree = async (type?: HubMembershipType) => {
    if (!hub) return;
    if (!profile) { goToSignIn(); return; }
    setActing(true);
    try {
      const m = await joinHub(hub.id, profile.id, type?.id ?? null);
      setMembership(m);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setJoinSuccess({
        title: m.status === 'active' ? 'You\'re in 🎉' : 'Request sent',
        message: m.status === 'active'
          ? `You're now a member of ${hub.name}.`
          : `${hub.name} approves new members — we'll let you in once they confirm.`,
      });
      load();
    } catch (e: any) {
      alert({ title: 'Could not join', message: e?.message ?? '' });
    } finally { setActing(false); }
  };

  // Tap a tier: free → join; paid + saved card → our confirm sheet; paid + no
  // card → straight to Stripe's Payment Sheet (which is itself the confirm).
  const onTapTier = (type: HubMembershipType) => {
    if (hub) track('hub_membership_started', { hubId: hub.id, objectType: 'membership_type', objectId: type.id });
    if (!profile) { goToSignIn(); return; }
    if (type.price_pence <= 0) { onJoinFree(type); return; }
    // Always open the confirm sheet — it offers wallet AND card. The card path
    // uses Stripe's Payment Sheet (collects a card even if none is saved), so a
    // card-less but wallet-funded member is no longer shut out.
    setPayingType(type);
  };

  const runMembershipWallet = async (type: HubMembershipType) => {
    if (!hub || !profile) return;
    setActing(true);
    try {
      const res = await walletCheckout({ type: 'hub_membership', membership_type_id: type.id }, attemptId());
      if (typeof res?.balance_pence === 'number') setWalletBalance(res.balance_pence);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setJoinSuccess({ title: 'You\'re in 🎉', message: `You're now a member of ${hub.name}.` });
      load();
    } catch (e: any) {
      alert({ title: 'Payment failed', message: e?.message ?? 'Please try again.' });
    } finally { setActing(false); }
  };

  const runMembershipPayment = async (type: HubMembershipType) => {
    if (!hub || !profile) return;
    setActing(true);
    try {
      const useSaved = !!profile.has_payment_method;
      const start = await startHubMembershipPayment(type.id, memberAttempt(), useSaved);
      if (!start.charged) {
        if (!start.clientSecret) throw new Error('Could not start payment.');
        const initRes = await initPaymentSheet({
          merchantDisplayName: 'OneShetland',
          paymentIntentClientSecret: start.clientSecret,
          applePay: { merchantCountryCode: 'GB' },
        });
        if (initRes.error) throw new Error(initRes.error.message);
        const sheetRes = await presentPaymentSheet();
        if (sheetRes.error) {
          if (sheetRes.error.code !== 'Canceled') throw new Error(sheetRes.error.message);
          return; // user cancelled
        }
      }
      await confirmHubMembership(start.payment_intent_id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setJoinSuccess({ title: 'You\'re in 🎉', message: `You're now a member of ${hub.name}.` });
      load();
    } catch (e: any) {
      alert({ title: 'Payment failed', message: e?.message ?? 'Please try again.' });
    } finally {
      setActing(false);
      setMemberSession(n => n + 1);
    }
  };

  const onLeave = () => {
    if (!hub || !profile) return;
    alert({
      title: 'Leave hub?',
      message: `Leave ${hub.name}? You can re-join any time.`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Leave', style: 'destructive',
          onPress: async () => {
            setActing(true);
            try { await leaveHub(hub.id, profile.id); setMembership(null); load(); }
            finally { setActing(false); }
          },
        },
      ],
    });
  };

  if (loading) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><ActivityIndicator color={S.color} /></View></SafeAreaView>;
  }
  if (!hub) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><Text style={styles.muted}>Hub not found.</Text></View></SafeAreaView>;
  }

  const maxW = isTablet ? Math.min(980, contentWidth - spacing.lg * 2) : undefined;

  // ── Sections (extracted so phone stacks them and tablet splits into columns) ──
  const membershipState = isAdmin ? (
    <View style={[styles.statePill, { backgroundColor: accent + '18' }]}>
      <FontAwesome5 name="user-shield" size={12} color={accent} solid />
      <Text style={[styles.statePillText, { color: accent }]}>
        You {membership?.role === 'owner' ? 'own' : 'help run'} this hub
      </Text>
    </View>
  ) : isMember ? (
    <View>
      <View style={styles.memberRow}>
        <View style={[styles.statePill, { backgroundColor: accent + '18' }]}>
          <FontAwesome5 name="check" size={11} color={accent} solid />
          <Text style={[styles.statePillText, { color: accent }]}>{myType?.name ?? 'Member'}</Text>
        </View>
        <TouchableOpacity onPress={onLeave} hitSlop={8}><Text style={styles.leaveText}>Leave</Text></TouchableOpacity>
      </View>
      {(membership?.member_no || membership?.paid_until) ? (
        <View style={styles.memberMetaRow}>
          <Text style={styles.memberMeta}>
            {membership?.member_no ? `Member #${membership.member_no}` : ''}
            {membership?.member_no && membership?.paid_until ? '  ·  ' : ''}
            {membership?.paid_until
              ? (new Date(membership.paid_until) > new Date()
                  ? `Renews ${fmtDate(membership.paid_until)}`
                  : `Expired ${fmtDate(membership.paid_until)}`)
              : ''}
          </Text>
          {myType && myType.price_pence > 0 ? (
            <TouchableOpacity onPress={() => onTapTier(myType)} hitSlop={8} disabled={acting}>
              <Text style={[styles.renewLink, { color: accent }]}>Renew</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  ) : isExpired ? (
    <View>
      <View style={[styles.statePill, { backgroundColor: '#FEF3C7', alignSelf: 'flex-start' }]}>
        <FontAwesome5 name="exclamation-circle" size={11} color="#B45309" solid />
        <Text style={[styles.statePillText, { color: '#B45309' }]}>Membership expired</Text>
      </View>
      <Text style={[styles.memberMeta, { marginTop: 8 }]}>
        {membership?.member_no ? `Member #${membership.member_no}  ·  ` : ''}Expired {fmtDate(membership!.paid_until!)}
      </Text>
      {myType && myType.price_pence > 0 ? (
        <TouchableOpacity style={[styles.joinBtn, { backgroundColor: accent, marginTop: spacing.md }]}
          onPress={() => onTapTier(myType)} disabled={acting} activeOpacity={0.85}>
          {acting ? <ActivityIndicator color="#fff" /> : (
            <>
              <FontAwesome5 name="redo" size={12} color="#fff" solid />
              <Text style={styles.joinBtnText}>Renew {myType.name} — {formatMembershipPrice(myType.price_pence, myType.period)}</Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={onLeave} hitSlop={8} style={{ marginTop: 12, alignSelf: 'flex-start' }}>
        <Text style={styles.leaveText}>Leave hub</Text>
      </TouchableOpacity>
    </View>
  ) : isPending ? (
    <View style={[styles.statePill, { backgroundColor: '#FEF3C7' }]}>
      <FontAwesome5 name="hourglass-half" size={11} color="#B45309" solid />
      <Text style={[styles.statePillText, { color: '#B45309' }]}>Request pending</Text>
    </View>
  ) : types.length > 0 ? (
    <View style={styles.tierList}>
      <Text style={styles.tierListLabel}>Ways to join</Text>
      {types.map(t => (
        <View key={t.id} style={styles.tierRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.tierRowName}>{t.name}</Text>
            {t.description ? <Text style={styles.tierRowDesc} numberOfLines={2}>{t.description}</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Text style={[styles.tierRowPrice, { color: t.price_pence ? accent : colors.textMuted }]}>
              {formatMembershipPrice(t.price_pence, t.period)}
            </Text>
            <TouchableOpacity style={[styles.tierJoinBtn, { backgroundColor: accent }]}
              onPress={() => onTapTier(t)} disabled={acting} activeOpacity={0.85}>
              <Text style={styles.tierJoinText}>
                {t.price_pence > 0 ? 'Join' : (hub.join_mode === 'open' ? 'Join' : 'Request')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </View>
  ) : (
    <TouchableOpacity style={[styles.joinBtn, { backgroundColor: accent }]} onPress={() => { track('hub_membership_started', { hubId: hub.id, objectType: 'membership_type' }); onJoinFree(); }} disabled={acting} activeOpacity={0.85}>
      {acting ? <ActivityIndicator color="#fff" /> : (
        <>
          <FontAwesome5 name="user-plus" size={13} color="#fff" solid />
          <Text style={styles.joinBtnText}>{hub.join_mode === 'open' ? 'Join hub' : 'Request to join'}</Text>
        </>
      )}
    </TouchableOpacity>
  );

  const aboutBlock = hub.description ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>About</Text>
      <Text style={styles.body2}>{hub.description}</Text>
    </View>
  ) : null;

  const campaignBlock = campaign ? (
    <TouchableOpacity style={[styles.section, styles.campaignCard]} onPress={() => router.push(`/hub-campaign?id=${campaign.id}`)} activeOpacity={0.9}>
      <View style={styles.campaignHead}>
        <FontAwesome5 name="hand-holding-heart" size={13} color={accent} solid />
        <Text style={styles.campaignTitle} numberOfLines={1}>{campaign.title}</Text>
      </View>
      <FundraisingProgress raisedPence={campaign.raised_pence} goalPence={campaign.goal_pence}
        donorCount={campaign.donor_count} endsAt={campaign.ends_at} accent={accent} compact />
      {campaignAcceptsDonations(campaign) ? (
        <TouchableOpacity style={[styles.donateMini, { backgroundColor: accent }]} onPress={() => router.push(`/hub-donate?campaign=${campaign.id}`)} activeOpacity={0.85}>
          <FontAwesome5 name="heart" size={12} color="#fff" solid />
          <Text style={styles.donateMiniText}>Donate</Text>
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  ) : null;

  const contactBlock = (hub.contact_email || hub.contact_phone || hub.website) ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Contact</Text>
      <View style={styles.infoCard}>
        {hub.contact_phone ? <InfoRow icon="phone" label={hub.contact_phone} onPress={() => { track('contact_clicked', { objectType: 'hub', objectId: hub.id, hubId: hub.id, props: { method: 'phone' } }); Linking.openURL(`tel:${hub.contact_phone}`); }} accent={accent} /> : null}
        {hub.contact_email ? <InfoRow icon="envelope" label={hub.contact_email} onPress={() => { track('contact_clicked', { objectType: 'hub', objectId: hub.id, hubId: hub.id, props: { method: 'email' } }); Linking.openURL(`mailto:${hub.contact_email}`); }} accent={accent} /> : null}
        {hub.website ? <InfoRow icon="globe" label={hub.website} onPress={() => { track('contact_clicked', { objectType: 'hub', objectId: hub.id, hubId: hub.id, props: { method: 'website' } }); Linking.openURL(hub.website!); }} accent={accent} /> : null}
      </View>
    </View>
  ) : null;

  const directoryBlock = (hub.directory_enabled && (isMember || isAdmin)) ? (
    <TouchableOpacity style={[styles.linkRow, { marginTop: spacing.lg }]} onPress={() => router.push(`/hub-directory?id=${hub.id}`)} activeOpacity={0.8}>
      <View style={[styles.linkIcon, { backgroundColor: accent + '18' }]}><FontAwesome5 name="address-book" size={14} color={accent} solid /></View>
      <Text style={styles.linkText}>Member directory</Text>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  ) : null;

  const documentsBlock = docs.length > 0 ? (
    <View style={styles.section}>
      <View style={styles.sectionHeadRow}>
        <Text style={styles.sectionTitle}>Documents</Text>
        {isAdmin ? (
          <TouchableOpacity onPress={() => router.push(`/hub-documents?id=${hub.id}`)} hitSlop={8} style={styles.postBtn}>
            <FontAwesome5 name="cog" size={11} color={accent} solid />
            <Text style={[styles.postBtnText, { color: accent }]}>Manage</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {docs.slice(0, 6).map(d => (
        <TouchableOpacity key={d.id} style={styles.linkRow} onPress={() => Linking.openURL(d.url)} activeOpacity={0.7}>
          <View style={[styles.linkIcon, { backgroundColor: accent + '18' }]}><FontAwesome5 name="file-alt" size={13} color={accent} solid /></View>
          <Text style={styles.linkText} numberOfLines={1}>{d.title}</Text>
          <FontAwesome5 name="external-link-alt" size={11} color={colors.textLight} />
        </TouchableOpacity>
      ))}
    </View>
  ) : null;

  const noticesBlock = (
    <View style={styles.section}>
      <View style={styles.sectionHeadRow}>
        <Text style={styles.sectionTitle}>Notices</Text>
        {isAdmin && (
          <TouchableOpacity onPress={() => router.push(`/hub-notice-compose?hub=${hub.id}`)} hitSlop={8} style={styles.postBtn}>
            <FontAwesome5 name="plus" size={11} color={accent} solid />
            <Text style={[styles.postBtnText, { color: accent }]}>Post</Text>
          </TouchableOpacity>
        )}
      </View>
      {notices.length === 0 ? (
        <Text style={styles.muted}>No notices yet.</Text>
      ) : notices.map(n => (
        <View key={n.id} style={styles.notice}>
          {n.image_url ? <Image source={{ uri: n.image_url }} style={styles.noticeImg} /> : null}
          <View style={{ flex: 1 }}>
            <View style={styles.noticeTitleRow}>
              <Text style={styles.noticeTitle} numberOfLines={2}>{n.title}</Text>
              {n.visibility !== 'public' && (
                <View style={styles.memberTag}><FontAwesome5 name="lock" size={8} color="#6B47BF" solid /><Text style={styles.memberTagText}>Members</Text></View>
              )}
              {!isAdmin && (
                <ContentActions
                  contentType="notice"
                  contentId={n.id}
                  authorId={n.publisher_user_id}
                  style={{ marginLeft: 'auto' }}
                />
              )}
            </View>
            {n.body ? <Text style={styles.noticeBody} numberOfLines={3}>{n.body}</Text> : null}
            <Text style={styles.noticeDate}>{new Date(n.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>
            {n.campaign && n.campaign.status === 'active' ? (
              <View style={styles.noticeCampaign}>
                <FundraisingProgress raisedPence={n.campaign.raised_pence} goalPence={n.campaign.goal_pence}
                  donorCount={n.campaign.donor_count} endsAt={n.campaign.ends_at} accent={accent} compact />
                <TouchableOpacity style={[styles.noticeDonate, { backgroundColor: accent }]}
                  onPress={() => router.push(`/hub-donate?campaign=${n.campaign!.id}`)} activeOpacity={0.85}>
                  <FontAwesome5 name="heart" size={11} color="#fff" solid />
                  <Text style={styles.noticeDonateText}>Donate</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      ))}
      {!isMember && !isAdmin && (
        <Text style={styles.joinHint}>Join to see members-only updates.</Text>
      )}
    </View>
  );

  const upcomingEvents = events.filter(e =>
    new Date(e.starts_at).getTime() >= Date.now() - 6 * 3600_000
    && e.status !== 'cancelled' && e.status !== 'draft',
  ).slice(0, 6);

  const eventsBlock = (upcomingEvents.length > 0 || isAdmin) ? (
    <View style={styles.section}>
      <View style={styles.sectionHeadRow}>
        <Text style={styles.sectionTitle}>Events</Text>
        {isAdmin ? (
          <TouchableOpacity onPress={() => router.push(`/hub-events?id=${hub.id}`)} hitSlop={8} style={styles.postBtn}>
            <FontAwesome5 name="plus" size={11} color={accent} solid />
            <Text style={[styles.postBtnText, { color: accent }]}>New</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {upcomingEvents.length === 0 ? (
        <Text style={styles.muted}>No upcoming events.</Text>
      ) : upcomingEvents.map(ev => (
        <TouchableOpacity key={ev.id} style={styles.eventRow} onPress={() => router.push(`/events/${ev.id}`)} activeOpacity={0.8}>
          <View style={[styles.eventDate, { backgroundColor: accent + '14' }]}>
            <Text style={[styles.eventDay, { color: accent }]}>{new Date(ev.starts_at).getDate()}</Text>
            <Text style={[styles.eventMon, { color: accent }]}>{new Date(ev.starts_at).toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.eventTitle} numberOfLines={1}>{ev.title}</Text>
            <Text style={styles.eventMeta} numberOfLines={1}>
              {new Date(ev.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              {ev.venue ? `  ·  ${ev.venue}` : ''}
            </Text>
          </View>
          {ev.has_tickets ? (
            <View style={[styles.ticketTag, { backgroundColor: accent }]}>
              <FontAwesome5 name="ticket-alt" size={10} color="#fff" solid />
              <Text style={styles.ticketTagText}>Tickets</Text>
            </View>
          ) : (
            <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
          )}
        </TouchableOpacity>
      ))}
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Hero banner */}
        <View style={[styles.banner, { backgroundColor: accent }]}>
          {hub.cover_url ? <Image source={{ uri: hub.cover_url }} style={StyleSheet.absoluteFill} /> : null}
          <View style={styles.bannerScrim} />
          <SafeAreaView edges={['top']} style={styles.bannerTop}>
            <HeroBackPill
              variant="overlay"
              label="Hubs"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/hubs'))}
            />
          </SafeAreaView>
        </View>

        <View style={[styles.body, maxW ? { width: maxW, alignSelf: 'center' } : null]}>
          {/* Identity */}
          <View style={styles.identityRow}>
            <View style={[styles.logo, { borderColor: accent }]}>
              {hub.logo_url
                ? <Image source={{ uri: hub.logo_url }} style={styles.logoImg} />
                : <FontAwesome5 name={(HUB_TYPE_ICONS[hub.type] ?? 'users') as any} size={26} color={accent} solid />}
            </View>
            {isAdmin && (
              <TouchableOpacity style={[styles.manageBtn, { borderColor: accent }]} onPress={() => router.push(`/hub-admin?id=${hub.id}`)} activeOpacity={0.8}>
                <FontAwesome5 name="cog" size={12} color={accent} solid />
                <Text style={[styles.manageBtnText, { color: accent }]}>Manage</Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.name}>{hub.name}</Text>
          <Text style={styles.type}>
            {HUB_TYPE_LABELS[hub.type]}
            {hub.area ? `  ·  ${hub.area}` : ''}
            {`  ·  ${memberCount} member${memberCount === 1 ? '' : 's'}`}
          </Text>

          {membershipState}

          {joinSuccess ? (
            <View style={[styles.successBanner, { backgroundColor: accent + '14', borderColor: accent }]}>
              <View style={[styles.successBannerIcon, { backgroundColor: accent + '22' }]}>
                <FontAwesome5 name="check" size={14} color={accent} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.successBannerTitle, { color: accent }]}>{joinSuccess.title}</Text>
                <Text style={styles.successBannerMsg}>{joinSuccess.message}</Text>
              </View>
              <TouchableOpacity onPress={() => setJoinSuccess(null)} hitSlop={10}>
                <FontAwesome5 name="times" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : null}

          {isTablet ? (
            <View style={styles.columns}>
              <View style={styles.mainCol}>
                {campaignBlock}
                {aboutBlock}
                {eventsBlock}
                {noticesBlock}
              </View>
              <View style={styles.sideCol}>
                {contactBlock}
                {directoryBlock}
                {documentsBlock}
              </View>
            </View>
          ) : (
            <>
              {campaignBlock}
              {aboutBlock}
              {eventsBlock}
              {contactBlock}
              {directoryBlock}
              {documentsBlock}
              {noticesBlock}
            </>
          )}
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>

      <ConfirmPaymentSheet
        visible={payingType != null}
        title="Confirm membership"
        itemName={payingType ? `${hub.name} — ${payingType.name}` : ''}
        lineItems={payingType ? [
          { label: `${payingType.name} membership`, amountPence: payingType.price_pence },
          { label: 'Booking fee', amountPence: HUB_MEMBERSHIP_FEE_PENCE, muted: true },
        ] : []}
        totalPence={payingType ? payingType.price_pence + HUB_MEMBERSHIP_FEE_PENCE : 0}
        payingWith="your saved card"
        policy={{ text: `Membership ${payingType?.period === 'once' ? 'is a one-off payment' : `renews ${payingType?.period === 'month' ? 'monthly' : 'yearly'}`}. Paid memberships are non-refundable.` }}
        loading={acting}
        onConfirm={() => { const t = payingType; setPayingType(null); if (t) runMembershipPayment(t); }}
        onCancel={() => setPayingType(null)}
        walletBalancePence={walletBalance}
        onConfirmWallet={() => { const t = payingType; setPayingType(null); if (t) runMembershipWallet(t); }}
        onTopUp={() => { setPayingType(null); router.push('/local-wallet'); }}
      />
    </SafeAreaView>
  );
}

function InfoRow({ icon, label, onPress, accent }: { icon: string; label: string; onPress: () => void; accent: string }) {
  return (
    <TouchableOpacity style={styles.infoRow} onPress={onPress} activeOpacity={0.7}>
      <FontAwesome5 name={icon as any} size={14} color={accent} solid />
      <Text style={styles.infoText} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  scroll: { paddingBottom: spacing.xl },

  banner: { height: 150, justifyContent: 'flex-start' },
  bannerScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.18)' },
  bannerTop: { paddingHorizontal: spacing.md },
  bannerBack: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' },

  body: { paddingHorizontal: spacing.md },
  identityRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: -34 },
  logo: { width: 72, height: 72, borderRadius: 20, borderWidth: 3, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 72, height: 72 },
  manageBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fff' },
  manageBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  name: { fontSize: 24, fontWeight: '900', color: colors.textPrimary, marginTop: 12, letterSpacing: -0.4 },
  type: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 3 },

  joinBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.lg, paddingVertical: 14, marginTop: spacing.md },
  joinBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  statePill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, marginTop: spacing.md },
  statePillText: { fontSize: fontSize.sm, fontWeight: '800' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: spacing.md },
  leaveText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },
  memberMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  memberMeta: { fontSize: fontSize.xs, color: colors.textMuted },
  renewLink: { fontSize: fontSize.sm, fontWeight: '800' },

  tierList: { marginTop: spacing.md, gap: 10 },
  tierListLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  tierRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  tierRowName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  tierRowDesc: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  tierRowPrice: { fontSize: fontSize.sm, fontWeight: '800' },
  tierJoinBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: radius.md },
  tierJoinText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  campaignCard: { backgroundColor: '#fff', borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.md },
  campaignHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  campaignTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, flex: 1 },
  donateMini: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md, paddingVertical: 12 },
  donateMiniText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  columns: { flexDirection: 'row', gap: spacing.xl, alignItems: 'flex-start' },
  mainCol: { flex: 1 },
  sideCol: { width: 320 },

  section: { marginTop: spacing.lg },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  linkIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  linkText: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  eventDate: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  eventDay: { fontSize: 18, fontWeight: '900', lineHeight: 20 },
  eventMon: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  eventTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  eventMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  ticketTag: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999 },
  ticketTagText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  body2: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 22 },
  postBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingBottom: 8 },
  postBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  infoCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  infoText: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600', flex: 1 },

  notice: { flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
  noticeImg: { width: 56, height: 56, borderRadius: 10 },
  noticeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noticeTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  noticeBody: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 3, lineHeight: 18 },
  noticeDate: { fontSize: 11, color: colors.textLight, marginTop: 5 },
  noticeCampaign: { marginTop: spacing.md, gap: spacing.sm },
  noticeDonate: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: radius.md, paddingVertical: 9, alignSelf: 'flex-start', paddingHorizontal: 18 },
  noticeDonateText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },
  memberTag: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EDE9FE', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  memberTagText: { fontSize: 9, fontWeight: '800', color: '#6B47BF' },
  joinHint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 4, fontStyle: 'italic' },

  successBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginTop: spacing.md,
  },
  successBannerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  successBannerTitle: { fontSize: fontSize.sm, fontWeight: '900' },
  successBannerMsg: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },
});
