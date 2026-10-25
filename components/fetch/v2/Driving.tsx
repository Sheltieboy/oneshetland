/**
 * Fetch v2 — the driver's side before a job (Step 12): the board and accepting, applying to drive, driver details and documents, and journeys.
 * The board shows only what the server's board shows: area, never an address; never the requester. The client never approves itself.
 */
import React, { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, radius, spacing } from '@/constants/theme';
import { fetchMessage, type BoardItem, type Region, type Run, type Size, type Verification } from '@/lib/fetch-api';
import { SIZE, VEHICLES, boardWhen, evidenceState, matchLabel, pounds, sizeLabel } from '@/lib/fetch/present';
import { fetchApi } from '@/lib/fetch/transport';
import { pickFetchPhoto, uploadFetchPhoto } from '@/lib/fetch/device';
import { ActionSheet, Check, Choice, FButton, FETCH, Field, Notice, Panel, RouteLine, s, stamp } from '@/components/fetch/v2/ui';

const SIZES = Object.keys(SIZE) as Size[];
const fits = (vehicle: string) => SIZES.slice(0, SIZES.indexOf(VEHICLES.find((v) => v.value === vehicle)?.maxSize ?? 'small') + 1);
const NEEDS_REG = (v: string) => !['on_foot', 'bicycle'].includes(v);
const place = (area: string | null, region: string) => `${area ? `${area}, ` : ''}${region}`;

// ── board ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function BoardCard({ item, runs, onOpen }: { item: BoardItem; runs: Run[]; onOpen: () => void }) {
  const m = matchLabel(item, runs);
  const run = item.match === 'your_run';
  const label = `${m ? `${m}. ` : ''}${place(item.pickup_area, item.pickup_region)} to ${place(item.destination_area, item.destination_region)}. ${item.item_description}. ${sizeLabel(item.size_class)}. ${boardWhen(item)}. You'd receive ${pounds(item.driver_pay_pence)}.`;
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens the Fetch to accept it"
      style={({ pressed }) => [s.card, run && { borderColor: FETCH, borderWidth: 2.5 }, pressed && { opacity: 0.9 }]}>
      {m && (
        <Text style={{ alignSelf: 'flex-start', overflow: 'hidden', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 3, marginBottom: spacing.sm, fontWeight: '800', fontSize: 12, letterSpacing: 0.4,
          color: run ? colors.white : colors.textPrimary, backgroundColor: run ? FETCH : item.match === 'beyond_vehicle' ? colors.offWhite : colors.fetchLight }}>
          {run ? '★ ' : ''}{m.toUpperCase()}
        </Text>
      )}
      <RouteLine from={place(item.pickup_area, item.pickup_region)} to={place(item.destination_area, item.destination_region)} ferry={item.ferry_required} />
      <Text style={[s.bodyStrong, { marginTop: 4 }]}>{item.item_description}</Text>
      <Text style={s.body}>{sizeLabel(item.size_class)}{item.handling_flags.includes('heavy_two_person') ? ' · two-person lift' : ''} · {boardWhen(item)}{item.matching_photo_ids.length ? ' · photo' : ''}</Text>
      <Text style={[s.bodyStrong, { marginTop: spacing.sm }]}>You'd receive {pounds(item.driver_pay_pence)}</Text>
      {!!item.match_summary && item.match !== 'other' && <Text style={s.muted}>{item.match_summary}</Text>}
    </Pressable>
  );
}

export function BoardList({ items, runs, showAll, problem, setShowAll, open, go }: {
  items: BoardItem[]; runs: Run[]; showAll: boolean; problem: string | null; setShowAll: (v: boolean) => void; open: (id: string) => void; go: (p: string) => void;
}) {
  return (
    <View>
      {problem && <Notice tone="warn"><Text style={s.body}>{problem} You can look, but can't accept a Fetch until it's sorted.</Text><FButton label="Check your driver details" kind="quiet" onPress={() => go('/fetch/driver/verification')} /></Notice>}
      <View accessibilityRole="tablist" style={[s.row, { gap: spacing.sm, marginBottom: spacing.md }]}>
        {[{ v: false, l: 'Suits you' }, { v: true, l: 'Show all' }].map((t) => (
          <Pressable key={t.l} onPress={() => setShowAll(t.v)} accessibilityRole="tab" accessibilityState={{ selected: showAll === t.v }}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.full, backgroundColor: showAll === t.v ? colors.navy : colors.white, borderWidth: 1, borderColor: colors.border }}>
            <Text style={{ fontWeight: '700', color: showAll === t.v ? colors.white : colors.navy }}>{t.l}</Text>
          </Pressable>
        ))}
      </View>
      {items.length === 0 ? (
        <Panel>
          <Text style={s.body}>{showAll ? 'No Fetches are waiting right now.' : 'Nothing suits your journeys or areas right now.'}</Text>
          <FButton label="Tell us where you're going" kind="quiet" onPress={() => go('/fetch/journeys/new')} />
          {!showAll && <FButton label="Show all" kind="quiet" onPress={() => setShowAll(true)} />}
        </Panel>
      ) : items.map((i) => <BoardCard key={i.request_id} item={i} runs={runs} onOpen={() => open(i.request_id)} />)}
    </View>
  );
}

/** Accepting a Fetch. Large and bulky need the fit confirmed. The server decides; its answer is shown in words, never a generic failure. */
export function AcceptPanel({ item, runs, problem, onAccepted, go }: { item: BoardItem; runs: Run[]; problem: string | null; onAccepted: () => void; go: (p: string) => void }) {
  const needsFit = item.size_class === 'large' || item.size_class === 'bulky';
  const [fit, setFit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string; fix?: { label: string; path: string } } | null>(null);
  const [done, setDone] = useState(false);
  const m = matchLabel(item, runs);

  async function accept() {
    setBusy(true); setMsg(null);
    const r = await fetchApi.accept(item.request_id, needsFit ? fit : true).catch(() => null);
    setBusy(false);
    if (!r) { setMsg({ tone: 'error', text: "We couldn't reach OneShetland. Please try again — you won't accept it twice." }); return; }
    if (!r.ok) {
      const fix = r.code === 'driver_payouts_not_enabled' ? { label: 'Set up payouts', path: '/(driver)/connect-bank' }
        : r.code.startsWith('driver_verification') || r.code === 'driver_not_approved' ? { label: 'Your driver details', path: '/fetch/driver/verification' } : undefined;
      setMsg({ tone: 'error', text: r.message, fix });
      return;
    }
    setDone(true);
    setMsg(r.data.can_collect ? { tone: 'ok', text: "It's yours. The payment is confirmed — you can collect the item." }
      : r.data.payment === 'requires_action' || r.data.payment === 'requires_payment_method'
        ? { tone: 'warn', text: "It's yours. The requester needs to confirm the payment with their bank first — please don't collect until the job says it's ready. If they don't in time, the job is released and you're told." }
        : { tone: 'warn', text: "It's yours. We're confirming the requester's payment — please don't collect until the job says it's ready." });
    onAccepted();
  }
  async function view(photo: string) {
    const r = await fetchApi.photoView(photo, true).catch(() => null);
    if (r?.ok) Linking.openURL(r.data.url); else setMsg({ tone: 'error', text: r?.message ?? "We couldn't open that photo." });
  }

  return (
    <View>
      {m && <Text style={[s.label, { color: FETCH }]}>{m.toUpperCase()}</Text>}
      <Panel>
        <RouteLine from={place(item.pickup_area, item.pickup_region)} to={place(item.destination_area, item.destination_region)} ferry={item.ferry_required} />
        <Text style={[s.muted, { marginTop: spacing.sm }]}>You'd receive</Text><Text style={[s.statusLabel, { flex: 0 }]}>{pounds(item.driver_pay_pence)}</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>When</Text><Text style={s.body}>{boardWhen(item)}</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>Size</Text>
        <Text style={s.body}>{sizeLabel(item.size_class)}{item.approx_dimensions_cm ? ` · about ${item.approx_dimensions_cm.l}×${item.approx_dimensions_cm.w}×${item.approx_dimensions_cm.h} cm` : ''}</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>Handling</Text>
        <Text style={s.body}>{[item.handling_flags.includes('heavy_two_person') && 'Two-person lift', item.handling_flags.includes('fragile') && 'Fragile'].filter(Boolean).join(' · ') || 'Nothing special'}</Text>
        {!!item.match_summary && <Text style={[s.muted, { marginTop: 4 }]}>{item.match_summary}</Text>}
        {item.matching_photo_ids.map((p, i) => <FButton key={p} label={`View photo${item.matching_photo_ids.length > 1 ? ` ${i + 1}` : ''}`} kind="quiet" onPress={() => view(p)} />)}
      </Panel>
      {problem && <Notice tone="warn">{problem}</Notice>}
      {item.match === 'beyond_vehicle' && <Notice tone="warn">This is larger than your vehicle takes.</Notice>}
      {needsFit && <Check label="I've checked the item details and it will fit in my vehicle." value={fit} onChange={setFit} />}
      <Text style={[s.muted, { marginBottom: spacing.sm }]}>Accepting means you'll collect and deliver it. The exact addresses are shown once you accept.</Text>
      {msg && <Notice tone={msg.tone}><Text style={s.body}>{msg.text}</Text>{msg.fix && <FButton label={msg.fix.label} kind="quiet" onPress={() => go(msg.fix!.path)} />}</Notice>}
      {done ? <FButton label="Open the job" onPress={() => go(`/fetch/jobs/${item.request_id}`)} />
        : <FButton label="Accept this Fetch" onPress={accept} busy={busy} busyLabel="Accepting…" disabled={!item.can_claim || (needsFit && !fit)} />}
    </View>
  );
}

// ── applying ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function ApplyForm({ regions, onApplied }: { regions: Region[]; onApplied: () => void }) {
  const [vehicle, setVehicle] = useState<string | undefined>();
  const [size, setSize] = useState<Size | undefined>();
  const [two, setTwo] = useState(false);
  const [reg, setReg] = useState('');
  const [areas, setAreas] = useState<string[]>([]);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const sizes = useMemo(() => (vehicle ? fits(vehicle) : []), [vehicle]);

  async function submit() {
    const problems = [!vehicle && 'Choose your vehicle.', !size && 'Choose the largest size you can carry.',
      vehicle && NEEDS_REG(vehicle) && !reg.trim() && 'Enter your vehicle registration.', areas.length > 20 && 'Choose 20 areas at most.'].filter(Boolean) as string[];
    if (problems.length) { setMsg(problems.join(' ')); return; }
    setBusy(true); setMsg(null);
    const r = await fetchApi.apply({ vehicle_class: vehicle!, max_size_class: size!, can_two_person_lift: two, vehicle_reg: reg.trim() || undefined, statement: statement.trim() || undefined }).catch(() => null);
    if (r?.ok && areas.length) await fetchApi.setAreas(areas).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setMsg(r?.message ?? "We couldn't reach OneShetland. Please try again."); return; }
    onApplied();
  }

  return (
    <View>
      <Choice label="Your vehicle" value={vehicle} options={VEHICLES.map((v) => ({ value: v.value, label: v.label }))} onChange={(v) => { setVehicle(v); setSize(undefined); }} />
      {!!vehicle && <Choice label="The largest item you can carry" value={size} options={sizes.map((z) => ({ value: z, label: SIZE[z].label, hint: SIZE[z].hint }))} onChange={setSize} />}
      {!!vehicle && NEEDS_REG(vehicle) && <Field label="Registration" value={reg} onChangeText={(t) => setReg(t.toUpperCase())} maxLength={10} autoCapitalize="characters" autoCorrect={false} />}
      <Check label="I can bring a second person for items that need two to lift" value={two} onChange={setTwo} />
      <Text style={s.label}>Areas you're often in (optional)</Text>
      <Text style={[s.muted, { marginBottom: spacing.sm }]}>Fetches here will show as suiting you, even without a journey posted.</Text>
      {regions.map((r) => <Check key={r.id} label={r.name} value={areas.includes(r.id)} onChange={(on) => setAreas((a) => (on ? [...a, r.id] : a.filter((x) => x !== r.id)))} />)}
      <Field label="A few words about you (optional)" value={statement} onChangeText={setStatement} maxLength={500} multiline placeholder="e.g. I drive between Brae and Lerwick most weekdays." />
      <Text style={[s.muted, { marginBottom: spacing.sm }]}>Next you'll be asked for your driving licence and insurance. OneShetland checks them before you can accept a Fetch.</Text>
      {msg && <Notice tone="error">{msg}</Notice>}
      <FButton label="Apply to drive" onPress={submit} busy={busy} busyLabel="Sending…" />
    </View>
  );
}

const DRIVER_STATUS: Record<string, { label: string; detail: string }> = {
  pending: { label: 'Under review', detail: "OneShetland is checking your details. We'll let you know." },
  approved: { label: 'Approved', detail: 'You can accept Fetches while your documents are current.' },
  rejected: { label: 'Not approved', detail: "Your application wasn't approved." },
  suspended: { label: 'Paused', detail: 'Your driver account is paused. Please contact OneShetland.' },
};
const KIND: Record<string, string> = { driving_licence: 'Driving licence', licence: 'Driving licence', insurance: 'Insurance', vehicle: 'Vehicle details', identity: 'Proof of identity' };

/** A driver's own documents: state of each, the configured guidance, upload a new copy, view your own through a short-lived link. */
export function VerificationView({ v, applied, refresh }: { v: Verification; applied?: boolean; refresh: () => void }) {
  const st = DRIVER_STATUS[v.driver_status] ?? { label: 'Not applied', detail: '' };
  return (
    <View>
      {applied && <Notice tone="ok">Thanks — your application is in. Add your documents below so OneShetland can review it.</Notice>}
      <View accessible accessibilityRole="summary" accessibilityLabel={`${st.label}. ${st.detail}`} style={s.card}>
        <Text style={s.statusLabel}>{st.label}</Text>
        <Text style={s.body}>{st.detail}{v.decision_reason ? ` ${v.decision_reason}` : ''}</Text>
        {!!v.verified_until && <Text style={[s.body, { marginTop: 4 }]}>Documents current until {v.verified_until}.</Text>}
        {v.driver_status === 'approved' && !v.can_claim && v.claim_problem && <Text style={[s.bodyStrong, { marginTop: 4, color: colors.warningDark }]}>You can't accept Fetches right now. {fetchMessage(v.claim_problem)}</Text>}
        {v.vehicle?.vehicle_class && <Text style={[s.muted, { marginTop: 4 }]}>Vehicle: {VEHICLES.find((x) => x.value === v.vehicle.vehicle_class)?.label ?? v.vehicle.vehicle_class} · up to {sizeLabel(v.vehicle.max_size_class)}{v.vehicle.can_two_person_lift ? ' · two-person lift' : ''}</Text>}
      </View>
      {v.requirements.filter((r) => r.required).map((r) => <Requirement key={r.kind} r={r} refresh={refresh} />)}
      <VehicleChange current={v.vehicle?.vehicle_class} refresh={refresh} />
    </View>
  );
}

function Requirement({ r, refresh }: { r: Verification['requirements'][number]; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = evidenceState(r.current, r.awaiting_review);
  const mine = (r.awaiting_review ?? r.current) as { item_id?: string } | null;
  const note = (r.current as { note?: string } | null)?.note;
  async function add(source: 'camera' | 'library') {
    setMsg(null);
    const picked = await pickFetchPhoto(source);
    if (!picked) return;
    if (!picked.ok) { setMsg({ ok: false, text: picked.message }); return; }
    setBusy(true);
    const up = await uploadFetchPhoto(picked.photo, (m, sz) => fetchApi.evidenceBeginUpload(r.kind, m, sz), (u) => fetchApi.evidenceSubmit(u));
    setBusy(false);
    setMsg(up.ok ? { ok: true, text: 'Sent for review.' } : { ok: false, text: up.message });
    if (up.ok) refresh();
  }
  async function view(id: string) {
    const res = await fetchApi.evidenceView(id).catch(() => null);
    if (res?.ok) Linking.openURL(res.data.url); else setMsg({ ok: false, text: res?.message ?? "We couldn't open that." });
  }
  return (
    <Panel>
      <View accessible accessibilityLabel={`${KIND[r.kind] ?? r.kind}: ${st.label}`}>
        <Text style={s.panelTitle}>{KIND[r.kind] ?? r.kind.replace(/_/g, ' ')}</Text>
        <Text style={[s.bodyStrong, { color: st.tone === 'good' ? colors.successDark : st.tone === 'attention' ? colors.warningDark : colors.textSecondary }]}>
          {st.tone === 'good' ? '✓ ' : st.tone === 'attention' ? '! ' : ''}{st.label}</Text>
      </View>
      {!!r.guidance && <Text style={[s.body, { marginTop: 4 }]}>{r.guidance}</Text>}
      {!!note && st.label === 'Needs replacing' && <Text style={[s.body, { marginTop: 4 }]}>OneShetland said: {note}</Text>}
      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        {mine?.item_id && <FButton label="View what I sent" kind="quiet" onPress={() => view(mine.item_id!)} />}
        <FButton label={r.current || r.awaiting_review ? 'Photograph a new copy' : 'Photograph it'} kind="secondary" onPress={() => add('camera')} busy={busy} busyLabel="Uploading…" />
        <FButton label="Choose a photo" kind="secondary" onPress={() => add('library')} disabled={busy} />
      </View>
      {msg && <View style={{ marginTop: spacing.sm }}><Notice tone={msg.ok ? 'ok' : 'error'}>{msg.text}</Notice></View>}
    </Panel>
  );
}

function VehicleChange({ current, refresh }: { current?: string; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [vehicle, setVehicle] = useState<string | undefined>();
  const [size, setSize] = useState<string | undefined>();
  const [reg, setReg] = useState('');
  if (!open) return <FButton label="Changed your vehicle?" kind="quiet" onPress={() => setOpen(true)} />;
  return (
    <Panel title="Your new vehicle">
      <Choice label="New vehicle" value={vehicle} options={VEHICLES.filter((v) => v.value !== current).map((v) => ({ value: v.value, label: v.label }))} onChange={(v) => { setVehicle(v); setSize(undefined); }} />
      {!!vehicle && <Choice label="Largest item" value={size} options={fits(vehicle).map((z) => ({ value: z, label: SIZE[z].label }))} onChange={setSize} />}
      {!!vehicle && NEEDS_REG(vehicle) && <Field label="Registration" value={reg} onChangeText={(t) => setReg(t.toUpperCase())} autoCapitalize="characters" />}
      {!!vehicle && !!size && (!NEEDS_REG(vehicle) || !!reg.trim()) && (
        <ActionSheet trigger="Save my vehicle" title="Change your vehicle?" confirm="Change vehicle" refresh={refresh}
          body="Your vehicle's insurance and details will need checking again before you can accept another Fetch. Jobs you already have aren't affected."
          run={() => fetchApi.setVehicle({ vehicle_class: vehicle, max_size_class: size, vehicle_reg: reg.trim() || undefined })} />
      )}
    </Panel>
  );
}

// ── journeys ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function WhenPicker({ label, value, onChange }: { label: string; value: Date | null; onChange: (d: Date) => void }) {
  const [show, setShow] = useState(false);
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={s.label}>{label}</Text>
      <FButton label={value ? stamp(value.toISOString()) : 'Choose a date and time'} kind="secondary" onPress={() => setShow(true)} />
      {show && (
        <DateTimePicker value={value ?? new Date()} mode="datetime" minimumDate={new Date()} display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(e, d) => { if (Platform.OS !== 'ios') setShow(false); if (d && e.type !== 'dismissed') onChange(d); }} />
      )}
      {show && Platform.OS === 'ios' && <FButton label="Done" kind="quiet" onPress={() => setShow(false)} />}
    </View>
  );
}
export { WhenPicker };

/** Posting a journey: from, to, the departure window (≤12 h, up to 14 days ahead), what fits. Matching Fetches then show first. */
export function JourneyForm({ regions, categories, onPosted }: { regions: Region[]; categories: { slug: string; name: string }[]; onPosted: () => void }) {
  const [o, setO] = useState<string | undefined>(); const [d, setD] = useState<string | undefined>();
  const [start, setStart] = useState<Date | null>(null); const [end, setEnd] = useState<Date | null>(null);
  const [max, setMax] = useState<string | undefined>(); const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const opts = regions.map((r) => ({ value: r.id, label: r.name }));

  async function submit() {
    const now = Date.now(); const st = start?.getTime() ?? 0, en = end?.getTime() ?? 0;
    const problems = [!o && "Choose where you're leaving from.", !d && "Choose where you're going.", o && o === d && 'Choose two different places.',
      !st && "Choose when you're leaving.", st && st > now + 14 * 86400_000 && 'Journeys can be posted up to 14 days ahead.',
      !en && 'Choose your latest departure time.', st && en && (en <= st || en - st > 12 * 3600_000) && 'The window must be up to 12 hours after the earliest time.'].filter(Boolean) as string[];
    if (problems.length) { setMsg(problems.join(' ')); return; }
    setBusy(true); setMsg(null);
    const r = await fetchApi.createRun({ origin_region_id: o!, destination_region_id: d!, departure_start: start!.toISOString(), departure_end: end!.toISOString(),
      categories: cats, max_size_class: (max || null) as Size | null }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setMsg(r?.message ?? "We couldn't reach OneShetland. Please try again."); return; }
    onPosted();
  }
  return (
    <View>
      <Choice label="Leaving from" value={o} options={opts} onChange={setO} />
      <Choice label="Going to" value={d} options={opts} onChange={setD} />
      <WhenPicker label="Leaving from (earliest)" value={start} onChange={setStart} />
      <WhenPicker label="Leaving by (latest)" value={end} onChange={setEnd} />
      <Choice label="Room for (optional)" value={max} options={[{ value: '', label: 'Whatever my vehicle takes' }, ...SIZES.map((z) => ({ value: z, label: `${SIZE[z].label} and smaller` }))]} onChange={setMax} />
      {categories.length > 0 && <>
        <Text style={s.label}>Only these kinds of item (optional)</Text>
        {categories.map((c) => <Check key={c.slug} label={c.name} value={cats.includes(c.slug)} onChange={(on) => setCats((a) => (on ? [...a, c.slug] : a.filter((y) => y !== c.slug)))} />)}
      </>}
      {msg && <Notice tone="error">{msg}</Notice>}
      <FButton label="Post my journey" onPress={submit} busy={busy} busyLabel="Posting…" />
    </View>
  );
}

export function JourneyList({ runs, refresh, go }: { runs: Run[]; refresh: () => void; go: (p: string) => void }) {
  if (!runs.length) return <View><Text style={s.body}>No journeys posted. Post one and Fetches that fit show first.</Text><FButton label="Post a journey" kind="quiet" onPress={() => go('/fetch/journeys/new')} /></View>;
  return (
    <View>
      {runs.map((r) => (
        <View key={r.id} style={{ paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={s.bodyStrong}>{r.origin} → {r.destination}</Text>
          <Text style={s.muted}>{stamp(r.departure_start)}{r.max_size_class ? ` · up to ${sizeLabel(r.max_size_class)}` : ''}{r.crosses_water ? ' · ferry' : ''}</Text>
          {r.status === 'open' ? (
            <ActionSheet trigger="Cancel journey" title="Cancel this journey?" confirm="Cancel journey" danger refresh={refresh}
              body="Fetches will no longer be matched to it. Jobs you've already accepted aren't affected." run={() => fetchApi.cancelRun(r.id)} />
          ) : <Text style={s.muted}>{r.status === 'past' ? 'Past' : r.status === 'cancelled' ? 'Cancelled' : 'Closed'}</Text>}
        </View>
      ))}
    </View>
  );
}
