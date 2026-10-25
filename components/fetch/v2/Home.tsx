/**
 * Fetch v2 — the Fetch home, history, the coming-soon state and the one-time 18+ confirmation (Step 12). The same proposition and
 * words as the website: someone may already be going that way.
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, radius, spacing } from '@/constants/theme';
import type { JobSummary, RequestSummary, Run } from '@/lib/fetch-api';
import { driverStatus, pounds, requesterStatus, sizeLabel } from '@/lib/fetch/present';
import { fetchApi } from '@/lib/fetch/transport';
import { JourneyList } from '@/components/fetch/v2/Driving';
import { Check, FButton, FETCH, Notice, Panel, s, stamp } from '@/components/fetch/v2/ui';

const LIVE = ['pending', 'matched', 'collected', 'undeliverable'];
export type HomeData = { requests: RequestSummary[]; jobs: JobSummary[]; runs: Run[]; driverStatus: string | null };

function PathCard({ title, text, onPress }: { title: string; text: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${text}`}
      style={({ pressed }) => [s.card, { borderColor: FETCH, borderWidth: 2, opacity: pressed ? 0.9 : 1 }]}>
      <Text style={[s.statusLabel, { flex: 0 }]}>{title} →</Text>
      <Text style={[s.body, { marginTop: 4 }]}>{text}</Text>
    </Pressable>
  );
}

function HowItWorks() {
  return (
    <Panel title="How it works">
      {['Post what needs fetching. You see the price first: the driver’s payment, any ferry extra, and OneShetland’s fee.',
        'A driver who is going that way accepts it. Only then is your card authorised — nothing is taken yet.',
        'They collect it, bring it, and you’re charged for what actually happened.'].map((t, i) => (
        <Text key={i} style={[s.body, { marginBottom: 6 }]}>{i + 1}. {t}</Text>
      ))}
    </Panel>
  );
}

export function Proposition() {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: '800', color: colors.textPrimary }}>Someone's going that way</Text>
      <Text style={[s.body, { marginTop: 6 }]}>Someone may already be travelling that way. Fetch matches things that need moving with people already travelling across Shetland. You see the price before you post, and you're only charged once it's delivered.</Text>
    </View>
  );
}

export function FetchHome({ data, go, refresh }: { data: HomeData; go: (p: string) => void; refresh: () => void }) {
  const active = data.requests.filter((r) => LIVE.includes(r.status));
  const live = data.jobs.filter((j) => j.live);
  const driving = data.driverStatus === 'approved' || data.driverStatus === 'pending';
  return (
    <View>
      <Proposition />
      <PathCard title="I need something fetched" text="Tell us what, from where and to where. See the price, then post it." onPress={() => go('/fetch/new')} />
      <PathCard title="I'm travelling / I can fetch" text={driving ? 'See Fetches that suit your journeys and areas.' : "Earn on journeys you're already making. Apply to drive."}
        onPress={() => go(driving ? '/fetch/board' : '/fetch/drive')} />
      {active.length > 0 && (
        <Panel title="Your Fetches">
          {active.map((r) => <Row key={r.id} title={r.route} sub={r.item_description} right={requesterStatus(r).label} onPress={() => go(`/fetch/requests/${r.id}`)} />)}
        </Panel>
      )}
      {live.length > 0 && (
        <Panel title="Jobs you're doing">
          {live.map((j) => <Row key={j.id} title={j.route} sub={j.item_description} right={driverStatus({ status: j.status, payment_status: j.payment_status, cancel_requested_at: j.cancel_requested ? 'y' : null }).label}
            onPress={() => go(`/fetch/jobs/${j.id}`)} />)}
        </Panel>
      )}
      {driving && <Panel title="Your journeys"><JourneyList runs={data.runs.filter((r) => r.status === 'open')} refresh={refresh} go={go} /></Panel>}
      <HowItWorks />
      <FButton label="Your Fetch history" kind="quiet" onPress={() => go('/fetch/history')} />
    </View>
  );
}

function Row({ title, sub, right, onPress }: { title: string; sub: string; right: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${sub}. ${right}`}
      style={{ minHeight: 48, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={s.bodyStrong}>{title}</Text>
      <Text style={s.body}>{sub}</Text>
      <Text style={[s.bodyStrong, { color: FETCH }]}>{right}</Text>
    </Pressable>
  );
}

/** Past and current Fetches — the safe summary only (never addresses or phone numbers). */
export function History({ requests, jobs, go }: { requests: RequestSummary[]; jobs: JobSummary[]; go: (p: string) => void }) {
  return (
    <View>
      <Panel title="Fetches you asked for">
        {requests.length === 0 ? <Text style={s.muted}>None yet.</Text> : requests.map((r) => (
          <Row key={r.id} title={r.route} right={requesterStatus(r).label} onPress={() => go(`/fetch/requests/${r.id}`)}
            sub={`${r.item_description} · ${sizeLabel(r.size_class)} · ${stamp(r.created_at)}${r.total_fee_pence ? ` · ${pounds(r.total_fee_pence)}` : ''}`} />
        ))}
      </Panel>
      <Panel title="Fetches you drove">
        {jobs.length === 0 ? <Text style={s.muted}>None yet.</Text> : jobs.map((j) => (
          <Row key={j.id} title={j.route} right={driverStatus({ status: j.status }).label} onPress={() => go(`/fetch/jobs/${j.id}`)}
            sub={`${j.item_description} · ${stamp(j.claimed_at)}${j.driver_pay_pence && ['delivered', 'returned'].includes(j.status) ? ` · you earned ${pounds(j.driver_pay_pence)}` : ''}`} />
        ))}
        <Text style={[s.muted, { marginTop: spacing.sm }]}>A job's exact addresses are only shown for a short time after it finishes.</Text>
      </Panel>
    </View>
  );
}

/** Fetch is not available to this member (flag off, or not in the allowed audience). Nothing here invites anyone to request, drive or pay. */
export function ComingSoon() {
  return (
    <View accessible accessibilityLabel="Fetch is coming soon" style={{ padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border }}>
      <Text style={[s.label, { color: FETCH }]}>FETCH</Text>
      <Text style={{ fontSize: 28, fontWeight: '800', color: colors.navy }}>Coming soon</Text>
      <Text style={[s.body, { marginTop: spacing.sm }]}>We're rebuilding Fetch, our community collection and delivery service, so it works properly across Shetland — Mainland and the isles. It isn't taking requests or new drivers just now.</Text>
    </View>
  );
}

/** The one-time Fetch 18+ confirmation (Fetch eligibility only — not an app-wide age check). */
export function AdultGate({ onConfirmed }: { onConfirmed: () => void }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function go() {
    setBusy(true); setMsg(null);
    const r = await fetchApi.confirmAdult().catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setMsg(r?.message ?? "We couldn't reach OneShetland. Please try again."); return; }
    onConfirmed();
  }
  return (
    <Panel title="Before you use Fetch">
      <Text style={[s.body, { marginBottom: spacing.sm }]}>Fetch is for people aged 18 or over, whether you're asking for something or driving.</Text>
      <Check label="I confirm I am 18 or over." value={ok} onChange={setOk} />
      {msg && <Notice tone="error">{msg}</Notice>}
      <FButton label="Continue" onPress={go} disabled={!ok} busy={busy} busyLabel="Saving…" />
    </Panel>
  );
}
