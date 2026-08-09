/**
 * business-leads.tsx — the trade's side: what you cover, whether you have
 * room, and the jobs that came in.
 *
 * App twin of the website's /business/leads.
 *
 * Availability is at the TOP, above the leads, because it decides whether any
 * arrive and it's the thing most likely to go stale. A trade who set it in
 * March and stopped hearing anything by June should see why in one glance.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Linking, RefreshControl, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, shadow, spacing } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import {
  AVAILABILITY, AVAILABILITY_TTL_DAYS, CREDENTIALS, CREDENTIALS_DISCLAIMER,
  FREE_LEADS_PER_MONTH, SCALES, TRADES, TRADE_LABEL, URGENCIES,
  availabilityIsFresh, effectiveAvailability, hasUnlimitedLeads,
} from '@/constants/trades';
import { fetchLeads, respondToLead, saveTradeProfile, type Lead } from '@/lib/trades-api';

const ACCENT = '#2a8b5c';

const DECLINE = [
  { key: 'booked_up',   label: 'Booked up' },
  { key: 'too_small',   label: 'Too small' },
  { key: 'too_far',     label: 'Too far' },
  { key: 'wrong_trade', label: 'Not my trade' },
  { key: 'other',       label: "Can't take it" },
];

type Biz = {
  id: string; name: string; subscription_tier: string | null;
  trade_categories: string[] | null; trade_availability: string | null;
  trade_availability_set_at: string | null; trade_min_job_pence: number | null;
  trade_credentials: string[] | null;
};

export default function BusinessLeadsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [biz, setBiz] = useState<Biz | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);

  const [trades, setTrades] = useState<string[]>([]);
  const [availability, setAvailability] = useState<string | null>(null);
  const [minJob, setMinJob] = useState('');
  const [credentials, setCredentials] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    const { data } = await supabase
      .from('local_businesses')
      .select('id, name, subscription_tier, trade_categories, trade_availability, trade_availability_set_at, trade_min_job_pence, trade_credentials')
      .eq('owner_id', profile.id)
      .eq('is_active', true)
      .limit(1);
    const b = (data ?? [])[0] as Biz | undefined;
    if (!b) { setLoading(false); return; }
    setBiz(b);
    setTrades(b.trade_categories ?? []);
    setAvailability(b.trade_availability);
    setMinJob(b.trade_min_job_pence ? String(Math.round(b.trade_min_job_pence / 100)) : '');
    setCredentials(b.trade_credentials ?? []);
    setEditing(!b.trade_availability || (b.trade_categories ?? []).length === 0);
    setLeads(await fetchLeads(b.id));
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Job leads" accent={ACCENT} onClose={() => router.back()} />
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={ACCENT} />
      </SafeAreaView>
    );
  }

  if (!biz) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Job leads" accent={ACCENT} onClose={() => router.back()} />
        <View style={{ padding: spacing.md }}>
          <Text style={styles.note}>
            You&apos;ll need a business listing first. Claim yours and you can start receiving
            jobs folk are trying to get done.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const stale = !!biz.trade_availability && !availabilityIsFresh(biz.trade_availability_set_at);
  const live = effectiveAvailability(biz.trade_availability, biz.trade_availability_set_at);
  const unlimited = hasUnlimitedLeads(biz.subscription_tier);

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const thisMonth = leads.filter(l => new Date(l.createdAt) >= monthStart).length;

  async function save() {
    if (!biz) return;
    const ok = await saveTradeProfile(biz.id, {
      trades,
      availability,
      minJobPence: minJob.trim() ? Math.round(Number(minJob) * 100) : null,
      credentials,
    });
    if (ok) { setEditing(false); void load(); }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Job leads" subtitle={biz.name} accent={ACCENT} onClose={() => router.back()} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={ACCENT} />}
      >
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>What you do, and when</Text>
              <Text style={styles.cardMeta}>
                {trades.length === 0
                  ? 'Nothing set — no jobs will reach you.'
                  : `${trades.length} ${trades.length === 1 ? 'trade' : 'trades'} · ${availability ? AVAILABILITY.find(a => a.key === availability)?.label : 'availability not set'}`}
              </Text>
            </View>
            <TouchableOpacity onPress={() => { Haptics.selectionAsync(); setEditing(e => !e); }}>
              <Text style={styles.link}>{editing ? 'Close' : 'Change'}</Text>
            </TouchableOpacity>
          </View>

          {stale && !editing && (
            <Text style={styles.warn}>
              Your availability is more than {AVAILABILITY_TTL_DAYS} days old, so jobs have stopped
              coming. Confirm it and they&apos;ll start again.
            </Text>
          )}

          {editing && (
            <View style={{ marginTop: spacing.md }}>
              <Text style={styles.label}>Have you room for work?</Text>
              <Text style={styles.hint}>
                The one thing folk most want to know, and what decides whether jobs reach you.
                We&apos;ll ask again in {AVAILABILITY_TTL_DAYS} days.
              </Text>
              <Chips items={AVAILABILITY.map(a => ({ key: a.key, label: a.label }))} selected={availability ? [availability] : []} onToggle={setAvailability} />

              <Text style={styles.label}>What do you cover?</Text>
              <Chips
                items={TRADES.map(t => ({ key: t.key, label: t.label }))}
                selected={trades}
                onToggle={(k) => setTrades(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])}
              />

              <Text style={styles.label}>Smallest job worth your trip</Text>
              <Text style={styles.hint}>Optional, and it saves everybody a phone call.</Text>
              <TextInput style={styles.input} value={minJob} onChangeText={t => setMinJob(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad" placeholder="e.g. 150" placeholderTextColor={colors.textLight} />

              <Text style={styles.label}>Anything you&apos;re registered for?</Text>
              <Chips
                items={CREDENTIALS}
                selected={credentials}
                onToggle={(k) => setCredentials(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])}
              />
              <Text style={styles.disclaimer}>{CREDENTIALS_DISCLAIMER}</Text>

              <TouchableOpacity style={[styles.cta, { backgroundColor: ACCENT }]} onPress={save}>
                <Text style={styles.ctaText}>Save</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {!unlimited && (
          <View style={styles.quota}>
            <Text style={styles.quotaText}>
              <Text style={{ fontWeight: '900' }}>{thisMonth} of {FREE_LEADS_PER_MONTH}</Text> free leads used this month.
              {thisMonth >= FREE_LEADS_PER_MONTH
                ? ' Further jobs this month go to the next trade with room.'
                : ' After that, jobs go to the next trade with room.'}
            </Text>
            {/* Said plainly, because a trade will assume the opposite and the
                assumption would be corrosive. */}
            <Text style={styles.quotaFine}>
              Paying never puts you ahead in the queue — the order is who has room and who answers.
              It lifts the cap and adds the tools.
            </Text>
          </View>
        )}

        <Text style={styles.sectionHeading}>Jobs sent to you</Text>
        {leads.length === 0 ? (
          <Text style={styles.note}>
            {live
              ? "Nothing yet. When somebody posts a job you cover, it'll appear here."
              : "You haven't said whether you have room, so jobs aren't being sent to you. Set your availability above."}
          </Text>
        ) : leads.map(l => <LeadRow key={l.matchId} lead={l} onDone={load} />)}
      </ScrollView>
    </SafeAreaView>
  );
}

function LeadRow({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [answered, setAnswered] = useState(lead.status === 'interested' || lead.status === 'declined');
  const [current, setCurrent] = useState(lead.status);
  const [contact, setContact] = useState(lead.contact);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);

  const days = Math.floor((Date.now() - new Date(lead.brief.createdAt).getTime()) / 86400000);
  const scale = SCALES.find(s => s.key === lead.brief.scale);
  const urgency = URGENCIES.find(u => u.key === lead.brief.urgency);

  async function respond(kind: 'interested' | 'declined', reason?: string) {
    setBusy(true);
    const res = await respondToLead(lead.matchId, kind, reason);
    setBusy(false);
    if (!res.ok) return;
    setAnswered(true); setCurrent(kind); setDeclining(false);
    if (res.contact) setContact(res.contact);
    onDone();
  }

  return (
    <View style={styles.card}>
      <View style={styles.badgeRow}>
        {lead.brief.urgency === 'emergency' && <Text style={[styles.badge, { backgroundColor: '#FEE2E2', color: '#991B1B' }]}>Emergency</Text>}
        <Text style={styles.badge}>{scale?.label}</Text>
        <Text style={styles.cardMeta}>{lead.brief.location} · {days === 0 ? 'today' : `${days}d ago`}</Text>
      </View>
      <Text style={styles.cardTitle}>{lead.brief.title}</Text>
      <Text style={styles.cardMeta}>
        {lead.brief.trades.map(t => TRADE_LABEL[t] ?? t).join(' · ')} · {urgency?.label.toLowerCase()}
      </Text>
      <Text style={styles.description}>{lead.brief.description}</Text>

      {!!contact?.phone && (
        <View style={styles.interested}>
          <Text style={styles.interestedName}>{contact.name ?? 'Contact'}</Text>
          <Text style={styles.phone} onPress={() => Linking.openURL(`tel:${contact!.phone}`)}>{contact.phone}</Text>
          <Text style={styles.interestedHint}>
            Give them a ring — OneShetland doesn&apos;t pass messages, it just puts you in touch.
          </Text>
        </View>
      )}

      {!answered && !lead.brief.closed && (
        <View style={styles.actions}>
          {!declining ? (
            <>
              <TouchableOpacity style={[styles.cta, { backgroundColor: ACCENT, flex: 1 }, busy && { opacity: 0.6 }]}
                onPress={() => respond('interested')} disabled={busy}>
                <Text style={styles.ctaText}>I&apos;m interested</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondary} onPress={() => setDeclining(true)} disabled={busy}>
                <Text style={styles.secondaryText}>Can&apos;t take it</Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Why not? It helps them find somebody else.</Text>
              <Chips items={DECLINE} selected={[]} onToggle={(k) => respond('declined', k)} />
            </View>
          )}
        </View>
      )}

      {answered && current === 'declined' && (
        <Text style={styles.cardNote}>You passed on this one. Thanks — telling them quickly is genuinely useful.</Text>
      )}
    </View>
  );
}

function Chips({ items, selected, onToggle }: { items: { key: string; label: string }[]; selected: string[]; onToggle: (k: string) => void }) {
  return (
    <View style={styles.chips}>
      {items.map(i => {
        const on = selected.includes(i.key);
        return (
          <TouchableOpacity key={i.key}
            style={[styles.chip, on && { backgroundColor: ACCENT, borderColor: ACCENT }]}
            onPress={() => { Haptics.selectionAsync(); onToggle(i.key); }}
            activeOpacity={0.85}>
            <Text style={[styles.chipText, on && { color: '#fff' }]}>{i.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { padding: spacing.md, paddingBottom: spacing.xxl },
  card: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.cardBackground, ...shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  cardMeta: { marginTop: 2, fontSize: fontSize.xs, color: colors.textMuted },
  cardNote: { marginTop: spacing.sm, fontSize: fontSize.sm, color: colors.textMuted },
  description: { marginTop: spacing.sm, fontSize: fontSize.sm, lineHeight: 20, color: colors.textSecondary },
  link: { fontSize: fontSize.sm, fontWeight: '800', color: ACCENT },
  label: { marginTop: spacing.md, marginBottom: 4, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  hint: { marginBottom: 6, fontSize: fontSize.xs, lineHeight: 16, color: colors.textMuted },
  warn: { marginTop: spacing.sm, padding: 10, borderRadius: radius.sm, backgroundColor: colors.warningLight, color: colors.warningDark, fontSize: fontSize.xs, lineHeight: 16 },
  input: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  disclaimer: { marginTop: spacing.sm, fontSize: fontSize.xs, lineHeight: 16, color: colors.textMuted },
  quota: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.cardBackground, borderWidth: 1, borderColor: colors.border },
  quotaText: { fontSize: fontSize.sm, lineHeight: 19, color: colors.textSecondary },
  quotaFine: { marginTop: 6, fontSize: fontSize.xs, lineHeight: 16, color: colors.textMuted },
  sectionHeading: { marginTop: spacing.sm, marginBottom: spacing.sm, fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary },
  note: { fontSize: fontSize.sm, lineHeight: 20, color: colors.textMuted },
  badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  badge: { overflow: 'hidden', borderRadius: radius.full, backgroundColor: colors.screenBackground, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, fontWeight: '900', color: colors.textMuted },
  interested: { marginTop: spacing.md, padding: 12, borderRadius: radius.md, backgroundColor: '#D1FAE5' },
  interestedName: { fontSize: fontSize.sm, fontWeight: '800', color: '#065F46' },
  phone: { marginTop: 2, fontSize: fontSize.xl, fontWeight: '900', color: '#065F46', textDecorationLine: 'underline' },
  interestedHint: { marginTop: 6, fontSize: fontSize.xs, color: '#065F46' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: 18, paddingVertical: 13, borderRadius: radius.full },
  ctaText: { fontSize: fontSize.sm, fontWeight: '800', color: '#fff' },
  secondary: { paddingHorizontal: 16, paddingVertical: 13, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  secondaryText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
});
