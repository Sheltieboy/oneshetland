/**
 * get-it-done.tsx — describe a job, see who has room, send it.
 *
 * The app twin of the website's /get-it-done. Same tables, same matching
 * endpoint, same rules: at most 8 recipients, contact released only on a yes,
 * and the live match list telling the truth before anything is sent.
 *
 * The empty match state is the important one. "Nobody has said they have room"
 * is disappointing and honest — it's what folk in Shetland currently discover
 * after three unreturned calls, and getting it in ten seconds instead is most
 * of the value here. It never says "we'll find someone".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, shadow, spacing } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import { PeerieFill } from '@/components/ai/PeerieFill';
import { PEERIE, PEERIE_ENDPOINTS } from '@/constants/peerie';
import { useAuth } from '@/context/AuthContext';
import {
  AVAILABILITY_LABEL, CREDENTIALS_DISCLAIMER, CREDENTIAL_LABEL,
  SCALES, TRADES, TRADE_LABEL, URGENCIES,
  type Scale, type TradeKey, type Urgency,
} from '@/constants/trades';
import { findMatches, postBrief, type TradeMatch } from '@/lib/trades-api';

const S = SECTIONS.jobs;
const ACCENT = '#2a8b5c';

export default function GetItDoneScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [trades, setTrades] = useState<TradeKey[]>([]);
  const [scale, setScale] = useState<Scale>('unsure');
  const [urgency, setUrgency] = useState<Urgency>('flexible');
  const [locationText, setLocationText] = useState('');
  const [contactName, setContactName] = useState(profile?.display_name ?? profile?.full_name ?? '');
  const [contactPhone, setContactPhone] = useState('');

  const [questions, setQuestions] = useState<string[]>([]);
  const [emergencyNote, setEmergencyNote] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const [matches, setMatches] = useState<TradeMatch[] | null>(null);
  const [matching, setMatching] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<number | null>(null);

  const tradeKey = useMemo(() => trades.slice().sort().join(','), [trades]);

  // Debounced, so picking three trades in a row is one lookup rather than three.
  useEffect(() => {
    if (trades.length === 0) { setMatches(null); return; }
    let alive = true;
    setMatching(true);
    const t = setTimeout(async () => {
      const res = await findMatches({ trades, urgency, scale });
      if (alive) { setMatches(res); setMatching(false); }
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [tradeKey, urgency, scale, trades]);

  const applyPeerie = useCallback((d: Record<string, unknown>) => {
    if (typeof d.title === 'string' && d.title) setTitle(d.title);
    if (typeof d.description === 'string' && d.description) setDescription(d.description);
    if (Array.isArray(d.trades)) setTrades(d.trades as TradeKey[]);
    if (typeof d.scale === 'string') setScale(d.scale as Scale);
    if (typeof d.urgency === 'string') setUrgency(d.urgency as Urgency);
    if (typeof d.location === 'string' && d.location) setLocationText(d.location);
    setQuestions(Array.isArray(d.questions) ? (d.questions as string[]) : []);
    setEmergencyNote(typeof d.emergency_note === 'string' ? d.emergency_note : '');
  }, []);

  const submit = useCallback(async () => {
    if (!profile?.id) { setError('Please sign in to post a job.'); return; }
    if (title.trim().length < 3) { setError('Give the job a short title.'); return; }
    if (description.trim().length < 10) { setError('Say a bit more about the job.'); return; }
    if (trades.length === 0) { setError('Pick at least one trade.'); return; }
    if (locationText.trim().length < 2) { setError('Where is the work?'); return; }
    if (contactPhone.trim().length < 6) { setError('A phone number is how a trade gets back to you.'); return; }

    setSaving(true); setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const res = await postBrief(profile.id, {
      title, description, trades, scale, urgency,
      locationText, contactName, contactPhone,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Couldn't post that."); return; }
    setSentTo(res.sentTo ?? 0);
  }, [profile?.id, title, description, trades, scale, urgency, locationText, contactName, contactPhone]);

  if (sentTo !== null) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.doneWrap}>
          <Text style={styles.doneTick}>✅</Text>
          <Text style={styles.doneTitle}>
            {sentTo > 0 ? `Sent to ${sentTo} ${sentTo === 1 ? 'trade' : 'trades'}` : 'Posted'}
          </Text>
          <Text style={styles.doneBody}>
            {sentTo > 0
              ? "They'll get your details only if they say they're interested, and they'll ring you directly — this isn't a message thread."
              : "Nobody has said they have room for this yet, which is exactly the problem we're trying to fix. Your job is counted in the waiting list, and that list is what we use to get more trades signed up."}
          </Text>
          <TouchableOpacity style={[styles.cta, { backgroundColor: ACCENT }]} onPress={() => router.replace('/my-briefs')}>
            <Text style={styles.ctaText}>See your jobs</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View>
        <TabScreenHeader
          section={S}
          photo={SECTION_HEROES.jobs}
          title="Get it done"
          eyebrow="Find a tradesperson"
          subtitle="See who actually has room, before you send it"
        />
        {router.canGoBack() ? (
          <View style={{ position: 'absolute', top: insets.top + 12, left: spacing.md }}>
            <HeroBackPill variant="overlay" label="Back" onPress={() => router.back()} />
          </View>
        ) : null}
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <PeerieFill
            endpoint={PEERIE_ENDPOINTS.brief}
            accent={ACCENT}
            onBusyChange={setAiBusy}
            instruction="Describe the job the way you'd say it to somebody. I'll sort out which trades it needs and write it up."
            placeholder="e.g. The kitchen window's rotten and won't shut properly. Wooden sash, ground floor, in Scalloway. Not urgent but I'd like it done before the winter."
            onFill={applyPeerie}
          />

          {!!emergencyNote && (
            <View style={styles.emergency}>
              <Text style={styles.emergencyTitle}>Before anyone arrives</Text>
              <Text style={styles.emergencyBody}>{emergencyNote}</Text>
            </View>
          )}

          <Label>What needs doing?</Label>
          <TextInput style={styles.input} value={title} onChangeText={setTitle}
            placeholder="e.g. Rotten kitchen window, won't close" placeholderTextColor={colors.textLight} maxLength={120} />

          <Label>Tell them a bit more</Label>
          <TextInput style={[styles.input, styles.multi]} value={description} onChangeText={setDescription}
            multiline placeholder="What it is, where it is, anything that helps somebody decide."
            placeholderTextColor={colors.textLight} />

          {questions.length > 0 && (
            <View style={styles.questions}>
              <Text style={styles.questionsTitle}>{PEERIE.name} reckons they&apos;ll ask you this</Text>
              {questions.map((q, i) => <Text key={i} style={styles.questionsRow}>· {q}</Text>)}
              <Text style={styles.questionsHint}>
                Worth adding above — it saves a phone call, and lets a trade price it without coming out.
              </Text>
            </View>
          )}

          <Label>Which trade?</Label>
          <Text style={styles.hint}>Pick everything it needs — one firm covering the lot is often quickest.</Text>
          <Chips
            items={TRADES.map(t => ({ key: t.key, label: t.label }))}
            selected={trades}
            onToggle={(k) => setTrades(p => p.includes(k as TradeKey) ? p.filter(x => x !== k) : [...p, k as TradeKey])}
          />

          <Label>How big is it?</Label>
          <Chips items={SCALES.map(s => ({ key: s.key, label: s.label }))} selected={[scale]} onToggle={(k) => setScale(k as Scale)} />

          <Label>How soon?</Label>
          <Chips items={URGENCIES.map(u => ({ key: u.key, label: u.label }))} selected={[urgency]} onToggle={(k) => setUrgency(k as Urgency)} />

          <Label>Where is it?</Label>
          <TextInput style={styles.input} value={locationText} onChangeText={setLocationText}
            placeholder="e.g. Scalloway" placeholderTextColor={colors.textLight} maxLength={160} />

          {/* Live answer, before anything is sent. */}
          <MatchPanel matches={matches} loading={matching} trades={trades} />

          <View style={styles.contactCard}>
            <Text style={styles.contactTitle}>How they get back to you</Text>
            <Text style={styles.contactBlurb}>
              Only shown to a trade who says they&apos;re interested. Never in a list anyone can browse.
            </Text>
            <TextInput style={styles.input} value={contactName} onChangeText={setContactName}
              placeholder="Your name" placeholderTextColor={colors.textLight} />
            <View style={{ height: spacing.sm }} />
            <TextInput style={styles.input} value={contactPhone} onChangeText={setContactPhone}
              placeholder="Phone" placeholderTextColor={colors.textLight} keyboardType="phone-pad" />
          </View>

          {!!error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity
            style={[styles.cta, { backgroundColor: ACCENT }, (saving || aiBusy) && { opacity: 0.6 }]}
            onPress={submit}
            disabled={saving || aiBusy}
            activeOpacity={0.9}
          >
            {saving && <ActivityIndicator size="small" color="#fff" />}
            <Text style={styles.ctaText}>{saving ? 'Sending…' : 'Send it to the trades who have room'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

function Chips({
  items, selected, onToggle,
}: { items: { key: string; label: string }[]; selected: string[]; onToggle: (k: string) => void }) {
  return (
    <View style={styles.chips}>
      {items.map(i => {
        const on = selected.includes(i.key);
        return (
          <TouchableOpacity
            key={i.key}
            style={[styles.chip, on && { backgroundColor: ACCENT, borderColor: ACCENT }]}
            onPress={() => { Haptics.selectionAsync(); onToggle(i.key); }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{i.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function MatchPanel({ matches, loading, trades }: { matches: TradeMatch[] | null; loading: boolean; trades: TradeKey[] }) {
  if (matches === null && !loading) return null;
  if (loading && !matches) {
    return <View style={styles.matchCard}><Text style={styles.hint}>Looking…</Text></View>;
  }
  const withRoom = (matches ?? []).filter(m => m.availability === 'now' || m.availability === 'weeks');
  return (
    <View style={styles.matchCard}>
      <Text style={styles.matchHeading}>
        {matches!.length === 0 ? 'Nobody yet' : `${matches!.length} could take this on`}
      </Text>
      {matches!.length > 0 ? (
        <Text style={styles.hint}>
          {withRoom.length > 0
            ? `${withRoom.length} with room in the next few weeks.`
            : "None with room right now — they'll still see it."}
        </Text>
      ) : (
        <Text style={styles.hint}>
          No {trades.map(t => TRADE_LABEL[t]).join(' or ').toLowerCase() || 'trade'} on OneShetland has
          said they can take work on. Post it anyway — every unanswered job goes into the waiting
          list, and that list is what gets more trades signed up.
        </Text>
      )}

      {(matches ?? []).map(m => (
        <View key={m.id} style={styles.matchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.matchName}>{m.name}</Text>
            {m.credentials.length > 0 && (
              <Text style={styles.matchMeta}>
                {m.credentials.map(c => CREDENTIAL_LABEL[c] ?? c).join(' · ')}
              </Text>
            )}
            {m.minJobPence ? (
              <Text style={styles.matchMeta}>Smallest job about £{Math.round(m.minJobPence / 100)}</Text>
            ) : null}
          </View>
          <Text style={[styles.matchBadge, badgeStyle(m.availability)]}>
            {m.availability ? AVAILABILITY_LABEL[m.availability] : 'Not said'}
          </Text>
        </View>
      ))}

      {(matches ?? []).some(m => m.credentials.length > 0) && (
        <Text style={styles.disclaimer}>{CREDENTIALS_DISCLAIMER}</Text>
      )}
    </View>
  );
}

function badgeStyle(a: string | null) {
  if (a === 'now' || a === 'weeks') return { backgroundColor: '#D1FAE5', color: '#065F46' };
  if (a === 'months' || a === 'emergency') return { backgroundColor: colors.warningLight, color: colors.warningDark };
  return { backgroundColor: colors.screenBackground, color: colors.textMuted };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { padding: spacing.md, paddingBottom: spacing.xxl },

  label: { marginTop: spacing.lg, marginBottom: 6, fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  hint: { fontSize: fontSize.xs, lineHeight: 17, color: colors.textMuted },
  input: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.cardBackground, paddingHorizontal: 12, paddingVertical: 11,
    fontSize: fontSize.md, color: colors.textPrimary,
  },
  multi: { minHeight: 110, textAlignVertical: 'top' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardBackground,
  },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  chipTextOn: { color: '#fff' },

  questions: {
    marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.cardBackground, borderWidth: 1, borderColor: colors.border,
  },
  questionsTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  questionsRow: { marginTop: 4, fontSize: fontSize.sm, color: colors.textSecondary },
  questionsHint: { marginTop: 8, fontSize: fontSize.xs, color: colors.textMuted },

  emergency: {
    marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md,
    backgroundColor: '#FEE2E2', borderWidth: 2, borderColor: '#FCA5A5',
  },
  emergencyTitle: { fontSize: fontSize.sm, fontWeight: '900', color: '#991B1B' },
  emergencyBody: { marginTop: 4, fontSize: fontSize.sm, lineHeight: 19, color: '#991B1B' },

  matchCard: {
    marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.lg,
    backgroundColor: colors.cardBackground, ...shadow.card,
  },
  matchHeading: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginBottom: 2 },
  matchRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border,
  },
  matchName: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  matchMeta: { marginTop: 2, fontSize: fontSize.xs, color: colors.textMuted },
  matchBadge: {
    overflow: 'hidden', borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3,
    fontSize: 10, fontWeight: '900',
  },
  disclaimer: { marginTop: spacing.md, fontSize: fontSize.xs, lineHeight: 16, color: colors.textMuted },

  contactCard: {
    marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.lg,
    backgroundColor: colors.cardBackground, ...shadow.card,
  },
  contactTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  contactBlurb: { marginTop: 2, marginBottom: spacing.sm, fontSize: fontSize.xs, lineHeight: 16, color: colors.textMuted },

  error: { marginTop: spacing.md, padding: 12, borderRadius: radius.md, backgroundColor: colors.warningLight, color: colors.warningDark, fontWeight: '700', fontSize: fontSize.sm },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    marginTop: spacing.lg, paddingVertical: 15, borderRadius: radius.full,
  },
  ctaText: { fontSize: fontSize.md, fontWeight: '800', color: '#fff' },

  doneWrap: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  doneTick: { fontSize: 44 },
  doneTitle: { marginTop: spacing.md, fontSize: fontSize.xxl, fontWeight: '900', color: colors.textPrimary },
  doneBody: { marginTop: spacing.sm, fontSize: fontSize.md, lineHeight: 22, color: colors.textSecondary },
});
