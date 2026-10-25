/**
 * Asking for a Fetch on the phone (Step 12): collection → delivery → the item → timing → price & review → post. The same steps,
 * checks and words as the website (lib/fetch/flow.ts). The price comes only from the server's quote; the location is resolved only by
 * the server. Posting carries one key for this draft, so a repeated tap or a retry after a dropped connection is the same Fetch.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { colors, radius, spacing } from '@/constants/theme';
import type { Quote, Region, Size } from '@/lib/fetch-api';
import { STEPS, createInput, stepProblems, type Draft } from '@/lib/fetch/flow';
import { SIZE, TIMING, moneyLines, pounds } from '@/lib/fetch/present';
import { fetchApi } from '@/lib/fetch/transport';
import { fetchKey } from '@/lib/fetch/device';
import { WhenPicker } from '@/components/fetch/v2/Driving';
import { Check, Choice, FButton, FETCH, Field, MoneyTable, Notice, Panel, s } from '@/components/fetch/v2/ui';

const TITLES = ['Where is it being collected?', 'Where does it need to go?', 'What are we fetching?', 'When do you need it?', 'Your price'];

export function RequestWizard({ regions, categories, initial, onPosted, openPayments }: {
  regions: Region[]; categories: { slug: string; name: string }[]; initial?: { draft?: Draft; step?: number; quote?: Quote };
  onPosted: (requestId: string) => void; openPayments: () => void;
}) {
  const [d, setD] = useState<Draft>(initial?.draft ?? { pickup: {}, destination: {}, scheduling_mode: 'flexible' });
  const [step, setStep] = useState(initial?.step ?? 0);
  const [quote, setQuote] = useState<Quote | null>(initial?.quote ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [tried, setTried] = useState(false);
  const key = useRef(fetchKey());
  const problems = useMemo(() => stepProblems(step, d), [step, d]);
  const set = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setQuote(null); setError(null); };
  const regionName = (id?: string) => regions.find((r) => r.id === id)?.name ?? '';
  const withArea = (address?: string, id?: string) => {
    const area = regionName(id);
    return address && area && !address.toLowerCase().includes(area.toLowerCase()) ? `${address}, ${area}` : address ?? area;
  };

  async function next() {
    setTried(true);
    if (problems.length) return;
    setTried(false);
    if (step === 3) {
      setBusy(true); setError(null);
      const input = createInput(d, key.current);
      const r = await fetchApi.quote({ size_class: d.size_class!, pickup: input.pickup, destination: input.destination }).catch(() => null);
      setBusy(false);
      if (!r) { setError({ message: "We couldn't reach OneShetland. Please try again." }); return; }
      if (!r.ok) {
        setError({ message: r.message, code: r.code });
        if (['location_unresolved', 'region_mismatch', 'outside_service_area', 'area_not_supported'].includes(r.code)) setStep(r.end === 'destination' ? 1 : 0);
        return;
      }
      setQuote(r.data.quote);
    }
    setStep((x) => Math.min(x + 1, STEPS.length - 1));
  }

  async function post() {
    setBusy(true); setError(null);
    const r = await fetchApi.create(createInput(d, key.current)).catch(() => null);
    setBusy(false);
    if (!r) { setError({ message: "We couldn't reach OneShetland. Your Fetch may not have been posted — press Post again; it won't be posted twice." }); return; }
    if (!r.ok) { setError({ message: r.message, code: r.code }); return; }
    onPosted(r.data.request_id);
  }

  const placeStep = (which: 'pickup' | 'destination') => {
    const p = d[which];
    const up = (patch: Record<string, string>) => set({ [which]: { ...p, ...patch } } as Partial<Draft>);
    return (
      <View>
        <Choice label="Area" value={p.region_id} options={regions.map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => up({ region_id: v })} />
        <Field label="Address" value={p.address ?? ''} onChangeText={(t) => up({ address: t })} textContentType="fullStreetAddress" autoComplete="street-address"
          placeholder={which === 'pickup' ? 'e.g. 7 Westerloch, Brae' : 'e.g. 12 Hillhead, Lerwick'} />
        <Field label="Postcode (helps us find it)" value={p.postcode ?? ''} onChangeText={(t) => up({ postcode: t })} autoCapitalize="characters" textContentType="postalCode" placeholder="ZE1 0AA" />
        <Field label="Village or district (optional)" value={p.area ?? ''} onChangeText={(t) => up({ area: t })} />
        {which === 'pickup' ? <>
          <Field label="Name at the collection (optional)" value={d.pickup_name ?? ''} onChangeText={(t) => set({ pickup_name: t })} placeholder="e.g. the shop, or a person's name" />
          <Field label="Anything the driver needs to know to collect it (optional)" value={d.pickup_notes ?? ''} onChangeText={(t) => set({ pickup_notes: t })} multiline />
        </> : <Field label="Anything the driver needs to know to deliver it (optional)" value={d.delivery_notes ?? ''} onChangeText={(t) => set({ delivery_notes: t })} multiline />}
        <Text style={s.muted}>Only the driver who accepts your Fetch sees the exact address and notes. Other drivers just see the area.</Text>
      </View>
    );
  };

  const money = quote ? moneyLines(quote) : null;
  return (
    <View>
      <View accessibilityLabel={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} accessible style={[s.row, { flexWrap: 'wrap', gap: 6, marginBottom: spacing.md }]}>
        {STEPS.map((x, i) => (
          <Text key={x} style={{ overflow: 'hidden', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12, fontWeight: '700',
            color: i === step ? colors.white : i < step ? colors.successDark : colors.textMuted, backgroundColor: i === step ? FETCH : i < step ? colors.successLight : colors.offWhite }}>
            {i < step ? '✓ ' : ''}{i + 1}. {x}
          </Text>
        ))}
      </View>
      <Panel>
        <Text accessibilityRole="header" style={[s.statusLabel, { marginBottom: spacing.md, flex: 0 }]}>{TITLES[step]}</Text>
        {step === 0 && placeStep('pickup')}
        {step === 1 && placeStep('destination')}
        {step === 2 && (
          <View>
            <Choice label="What kind of item is it?" value={d.category_slug} options={categories.map((c) => ({ value: c.slug, label: c.name }))} onChange={(v) => set({ category_slug: v })} />
            <Field label="Describe it" value={d.item_description ?? ''} onChangeText={(t) => set({ item_description: t })} maxLength={140} placeholder="e.g. Two boxes of books"
              hint="Drivers see this before accepting. Please don't include names, phone numbers or addresses." />
            <Choice label="How big is it?" value={d.size_class} options={(Object.keys(SIZE) as Size[]).map((z) => ({ value: z, label: SIZE[z].label, hint: SIZE[z].hint }))} onChange={(v) => set({ size_class: v })} />
            {(d.size_class === 'large' || d.size_class === 'bulky') && (
              <View>
                <Text style={s.label}>Rough measurements in cm — so the driver can make sure it will fit</Text>
                <View style={[s.row, { gap: spacing.sm }]}>
                  {(['l', 'w', 'h'] as const).map((k) => (
                    <View key={k} style={{ flex: 1 }}>
                      <Field label={{ l: 'Length', w: 'Width', h: 'Height' }[k]} keyboardType="number-pad" value={d.dims?.[k] ?? ''} onChangeText={(t) => set({ dims: { ...d.dims, [k]: t } })} />
                    </View>
                  ))}
                </View>
              </View>
            )}
            <Check label="It needs two people to lift" value={!!d.two_person} onChange={(v) => set({ two_person: v })} />
            <Check label="It's fragile" value={!!d.fragile} onChange={(v) => set({ fragile: v })} />
            {(d.category_slug === 'pharmacy' || d.category_slug === 'takeaway') && (
              <Check label="I understand the driver is a member of the community, not a pharmacist or a food business, and only carries the sealed item." value={!!d.liability_acknowledged} onChange={(v) => set({ liability_acknowledged: v })} />
            )}
            {d.size_class === 'bulky' && <Notice>Bulky items need a photo before a driver can accept — you can add it as soon as your Fetch is posted.</Notice>}
          </View>
        )}
        {step === 3 && (
          <View>
            <Choice label="When do you need it?" value={d.scheduling_mode} options={(['asap', 'by', 'flexible'] as const).map((m) => ({ value: m, label: TIMING[m].label, hint: TIMING[m].hint }))} onChange={(v) => set({ scheduling_mode: v })} />
            {d.scheduling_mode === 'by' && <WhenPicker label="Needed by" value={d.needed_by ? new Date(d.needed_by) : null} onChange={(x) => set({ needed_by: x.toISOString() })} />}
            {d.scheduling_mode === 'flexible' && <WhenPicker label="Any time before" value={d.flexible_until ? new Date(d.flexible_until) : null} onChange={(x) => set({ flexible_until: x.toISOString() })} />}
            <Field label="Your phone number" value={d.contact_phone ?? ''} onChangeText={(t) => set({ contact_phone: t })} keyboardType="phone-pad" textContentType="telephoneNumber" />
            <Check label="Let my driver see this number while they have my Fetch (otherwise you'll message through OneShetland)" value={!!d.share_phone_with_driver} onChange={(v) => set({ share_phone_with_driver: v })} />
            <Check label="If nobody's in, the driver may leave it somewhere safe (they'll take a photo)" value={!!d.safe_place_allowed} onChange={(v) => set({ safe_place_allowed: v })} />
            {d.safe_place_allowed && <Field label="Where? (optional)" value={d.safe_place_note ?? ''} onChangeText={(t) => set({ safe_place_note: t })} placeholder="e.g. the porch" />}
          </View>
        )}
        {step === 4 && money && quote && (
          <View>
            <View style={{ backgroundColor: colors.offWhite, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md }}>
              <Text style={s.muted}>From</Text><Text style={s.body}>{withArea(d.pickup.address, d.pickup.region_id)}</Text>
              <Text style={[s.muted, { marginTop: 4 }]}>To</Text><Text style={s.body}>{withArea(d.destination.address, d.destination.region_id)}</Text>
              <Text style={[s.muted, { marginTop: 4 }]}>What</Text><Text style={s.body}>{d.item_description} · {d.size_class ? SIZE[d.size_class].label : ''}{d.two_person ? ' · two-person lift' : ''}</Text>
              <Text style={[s.muted, { marginTop: 4 }]}>When</Text><Text style={s.body}>{d.scheduling_mode ? TIMING[d.scheduling_mode].label : ''}</Text>
            </View>
            <MoneyTable lines={money.lines} total={money.total} />
            {quote.minimum_applied && <Text style={[s.muted, { marginTop: 4 }]}>This includes Fetch's minimum driver payment for a short trip.</Text>}
            {money.hold !== null && (
              <View style={{ backgroundColor: colors.offWhite, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md }}>
                <Text style={s.body}>Expected charge if everything goes normally: <Text style={s.bodyStrong}>{pounds(money.total)}</Text></Text>
                <Text style={s.body}>Temporary card authorisation: <Text style={s.bodyStrong}>up to {pounds(money.hold)}</Text></Text>
                <Text style={[s.muted, { marginTop: 4 }]}>{money.holdNote}</Text>
              </View>
            )}
            <Text style={[s.body, { marginTop: spacing.md }]}>Nothing is charged now. When a driver accepts, your saved card is authorised; you're charged when your item is delivered.</Text>
          </View>
        )}
        {error && <View style={{ marginTop: spacing.md }}><Notice tone="error"><Text style={s.body}>{error.message}</Text>
          {error.code === 'payment_method_required' && <FButton label="Add a card" kind="quiet" onPress={openPayments} />}</Notice></View>}
        {tried && problems.length > 0 && <View style={{ marginTop: spacing.md }}><Notice tone="warn">{problems.join('\n')}</Notice></View>}
        <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
          {step < 4
            ? <FButton label={step === 3 ? 'See the price' : 'Next'} onPress={next} busy={busy} busyLabel="Working out your price…" />
            : <FButton label="Post Fetch" onPress={post} busy={busy} busyLabel="Posting…" disabled={!quote} />}
          {step > 0 && <FButton label="Back" kind="secondary" onPress={() => { setStep((x) => Math.max(x - 1, 0)); setError(null); }} disabled={busy} />}
        </View>
      </Panel>
    </View>
  );
}
