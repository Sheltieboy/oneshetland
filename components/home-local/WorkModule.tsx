/**
 * WorkModule — jobs AND shifts as one "Work in Shetland" proposition for App Home V2 / Local V2.
 * Formal vacancies keep the established green vacancy presentation; a shift is told apart at a glance by an amber time
 * block (the amber the Work tab already uses for Shifts), a clock cue, a derived urgency label and a rate.
 * Real items open their real detail screens; the buttons open the Work tab.
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';
import { DisplayText } from '../DisplayText';
import { SectionHead, SIDE } from './ui';
import {
  clockRange, curateHome, curateLocal, shiftUrgency, shortDate, workTab,
  type WorkJob, type WorkSet, type WorkShift,
} from './work';

const JOBS = '#2A8B5C';
const SHIFTS = '#E8A020';
const SHIFT_INK = '#3B2400';
const SHIFT_TEXT = '#92580A';

function useGo() {
  const router = useRouter();
  const hub = (tab: 'jobs' | 'shifts') => router.push({ pathname: '/(tabs)/jobs' as never, params: { tab } });
  return {
    hub,
    shift: (s: WorkShift) => router.push({ pathname: '/shift-detail' as never, params: { id: s.id } }),
    job: (j: WorkJob) => router.push({ pathname: '/job/[id]' as never, params: { id: j.id } }),
  };
}

function Clock({ size = 22 }: { size?: number }) {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={SHIFT_INK} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx={12} cy={12} r={9} /><Path d="M12 7v5l3 2" />
    </Svg>
  );
}

export function ShiftCard({ s, now, onPress }: { s: WorkShift; now: Date; onPress: () => void }) {
  const label = shiftUrgency(s.startAt, s.endAt, now);
  const hot = label === 'TODAY' || label === 'TONIGHT';
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`Shift: ${s.title}, ${label ?? shortDate(s.startAt)} ${clockRange(s.startAt, s.endAt)}, ${s.rate}`}
      style={{ flexDirection: 'row', backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', borderWidth: hot ? 2 : 0, borderColor: SHIFTS }}
    >
      <View style={{ width: 104, backgroundColor: SHIFTS, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 6, gap: 2 }}>
        <Clock />
        <Text style={{ color: SHIFT_INK, fontSize: 12, fontWeight: '900', letterSpacing: 0.6, textAlign: 'center' }}>{label ?? shortDate(s.startAt).toUpperCase()}</Text>
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: SHIFT_INK, fontSize: 12.5, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{clockRange(s.startAt, s.endAt)}</Text>
      </View>
      <View style={{ flex: 1, paddingVertical: 11, paddingHorizontal: 13, justifyContent: 'center' }}>
        <Text style={{ color: SHIFT_TEXT, fontSize: 10, fontWeight: '900', letterSpacing: 1.1 }}>CASUAL SHIFT</Text>
        <DisplayText weight="bold" numberOfLines={2} style={{ fontSize: 17, lineHeight: 20, color: '#0F1C26', marginTop: 1 }}>{s.title}</DisplayText>
        <Text numberOfLines={1} style={{ color: '#6B7280', fontSize: 12, marginTop: 2 }}>{s.employer} · {s.where}</Text>
        <Text style={{ color: SHIFT_TEXT, fontSize: 13.5, fontWeight: '900', marginTop: 3 }}>{s.rate}</Text>
      </View>
    </Pressable>
  );
}

export function JobCard({ j, onPress }: { j: WorkJob; onPress: () => void }) {
  const contract = j.contract?.replace(/-/g, ' ');
  return (
    <Pressable onPress={onPress} style={{ backgroundColor: '#fff', borderRadius: 16, borderLeftWidth: 4, borderLeftColor: JOBS, padding: 14 }}>
      {!!contract && <Text style={{ color: JOBS, fontSize: 10, fontWeight: '900', letterSpacing: 1.1, textTransform: 'uppercase' }}>{contract}</Text>}
      <DisplayText weight="bold" numberOfLines={2} style={{ fontSize: 17, lineHeight: 20, color: '#0F1C26', marginTop: 1 }}>{j.title}</DisplayText>
      <Text numberOfLines={1} style={{ color: '#6B7280', fontSize: 12, marginTop: 3 }}>{[j.employer, j.where].filter(Boolean).join(' · ')}</Text>
      {!!j.pay && <Text style={{ color: JOBS, fontSize: 12.5, fontWeight: '800', marginTop: 4 }}>{j.pay}</Text>}
    </Pressable>
  );
}

/** Neither jobs nor shifts yet: a short, purposeful gateway — not a large empty module. */
export function WorkGateway({ onPress }: { onPress: () => void }) {
  return (
    <View style={{ paddingTop: 22, paddingHorizontal: SIDE }}>
      <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 16 }}>
        <Text style={{ color: JOBS, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 }}>JOBS &amp; SHIFTS</Text>
        <DisplayText weight="bold" style={{ fontSize: 22, lineHeight: 25, color: '#0F1C26', marginTop: 3 }}>Work in Shetland</DisplayText>
        <Text style={{ color: '#4B5563', fontSize: 13.5, lineHeight: 19, marginTop: 4 }}>Jobs, apprenticeships and casual shifts from Shetland employers. The first listings appear here as they&apos;re posted.</Text>
        <Pressable onPress={onPress} style={{ alignSelf: 'flex-start', backgroundColor: JOBS, borderRadius: 99, paddingHorizontal: 16, paddingVertical: 10, marginTop: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>See jobs &amp; shifts →</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function HomeWork({ work, now }: { work: WorkSet; now: Date }) {
  const go = useGo();
  if (work.jobs.length === 0 && work.shifts.length === 0) return <View style={{ paddingBottom: 26 }}><WorkGateway onPress={() => go.hub('jobs')} /></View>;
  const { shifts, jobs, moreShifts } = curateHome(work);
  return (
    <View style={{ paddingTop: 26, paddingBottom: 26 }}>
      <SectionHead eyebrow="Jobs & shifts" title="Work in Shetland" color={JOBS} />
      <View style={{ paddingHorizontal: SIDE, gap: 10 }}>
        {shifts.map((s) => <ShiftCard key={s.id} s={s} now={now} onPress={() => go.shift(s)} />)}
        {moreShifts > 0 && (
          <Pressable onPress={() => go.hub('shifts')} style={{ alignSelf: 'flex-end' }}>
            <Text style={{ color: SHIFT_TEXT, fontSize: 12.5, fontWeight: '800' }}>+{moreShifts} more {moreShifts === 1 ? 'shift' : 'shifts'} →</Text>
          </Pressable>
        )}
        {jobs.map((j) => <JobCard key={j.id} j={j} onPress={() => go.job(j)} />)}
        <Pressable onPress={() => go.hub(workTab(work))} style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 99, paddingHorizontal: 16, paddingVertical: 10, marginTop: 2 }}>
          <Text style={{ color: '#374151', fontSize: 13, fontWeight: '800' }}>See all jobs &amp; shifts →</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function LocalWork({ work, now }: { work: WorkSet; now: Date }) {
  const go = useGo();
  if (work.jobs.length === 0 && work.shifts.length === 0) return <WorkGateway onPress={() => go.hub('jobs')} />;
  const { shifts, jobs } = curateLocal(work);
  return (
    <View style={{ paddingTop: 26 }}>
      <SectionHead eyebrow="Work" title="Jobs & shifts" color={JOBS} />
      <View style={{ paddingHorizontal: SIDE, gap: 10 }}>
        {shifts.map((s) => <ShiftCard key={s.id} s={s} now={now} onPress={() => go.shift(s)} />)}
        {jobs.map((j) => <JobCard key={j.id} j={j} onPress={() => go.job(j)} />)}
        <Pressable onPress={() => go.hub(workTab(work))} style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 99, paddingHorizontal: 16, paddingVertical: 10, marginTop: 2 }}>
          <Text style={{ color: '#374151', fontSize: 13, fontWeight: '800' }}>See all jobs &amp; shifts →</Text>
        </Pressable>
      </View>
    </View>
  );
}
