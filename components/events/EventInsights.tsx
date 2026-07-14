/**
 * EventInsights.tsx — What's On differentiators (parity with the web at
 * oneshetland-web/components/events/EventInsights.tsx):
 *   • ScarcityStrip     — honest "selling fast" badge + sold bar + "only N left"
 *   • GoingCount        — social proof "N going"
 *   • GettingTherePanel — Shetland context: last ferry, weather at showtime, daylight
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { describeWeather, type EventConditions } from '@/lib/shetland-today';
import { FERRY_MORE_INFO } from '@/lib/ferry-timetable';
import type { EventScarcity } from '@/lib/events-api';
import type { WaysHome } from '@/lib/transit-data';

const AMBER = '#BA7517';
const AMBER_BG = '#FAEEDA';
const AMBER_TEXT = '#854F0B';

export function ScarcityStrip({ scarcity, bookedRecent }: { scarcity: EventScarcity; bookedRecent: number }) {
  if (!scarcity.measurable || scarcity.soldOut) return null;
  const showRecent = bookedRecent >= 5;
  if (!scarcity.sellingFast && !scarcity.almostGone && !showRecent) return null;

  return (
    <View style={styles.scarcity}>
      <View style={styles.scarcityRow}>
        <View style={styles.scarcityBadge}>
          <FontAwesome5 name="fire" size={11} color={AMBER_TEXT} solid />
          <Text style={styles.scarcityBadgeText}>{scarcity.almostGone ? 'Almost gone' : 'Selling fast'}</Text>
        </View>
        <Text style={styles.scarcityRight}>
          {scarcity.remaining <= 20 ? `Only ${scarcity.remaining} left` : `${scarcity.pctSold}% gone`}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${scarcity.pctSold}%` }]} />
      </View>
      {showRecent && <Text style={styles.recent}>{bookedRecent} booked in the last 24 hours</Text>}
    </View>
  );
}

export function GoingCount({ count }: { count: number }) {
  if (count < 3) return null;
  return (
    <View style={styles.goingPill}>
      <FontAwesome5 name="user-friends" size={11} color={colors.textSecondary} solid />
      <Text style={styles.goingText}>{count} going</Text>
    </View>
  );
}

export function GettingTherePanel({
  conditions,
  eventTime,
  accent,
  sectionTitleStyle,
}: {
  conditions: EventConditions;
  eventTime: string;
  accent: string;
  sectionTitleStyle?: object;
}) {
  const wx = describeWeather(conditions.weatherCode);
  const hasWeather = conditions.withinForecast && conditions.tempC !== null;
  const hasDaylight = conditions.daylight !== '—';
  if (!hasWeather && !hasDaylight) return null;

  const cells: { icon: string; label: string; value: string; sub?: string }[] = [];
  if (hasWeather) {
    cells.push({ icon: wx.icon, label: `Forecast, ${eventTime}`, value: `${conditions.tempC}°C`, sub: wx.label });
  }
  if (hasDaylight) {
    cells.push({
      icon: 'sun',
      label: 'Daylight',
      value: conditions.simmerDim ? 'Simmer dim' : `${conditions.sunrise}–${conditions.sunset}`,
      sub: conditions.simmerDim ? 'Light till late' : `${conditions.daylight} of daylight`,
    });
  }

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, sectionTitleStyle]}>Conditions</Text>
      <View style={styles.grid}>
        {cells.map((c, i) => (
          <View key={i} style={styles.cell}>
            <FontAwesome5 name={c.icon} size={13} color={accent} solid />
            <Text style={styles.cellLabel}>{c.label}</Text>
            <Text style={styles.cellValue}>{c.value}</Text>
            {c.sub ? <Text style={styles.cellSub}>{c.sub}</Text> : null}
          </View>
        ))}
      </View>
      <Text style={styles.caveat}>Weather from Open-Meteo. Conditions can change — check before you travel.</Text>
    </View>
  );
}

export function GettingHome({ ways }: { ways: WaysHome | null }) {
  if (!ways || ways.options.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Getting home</Text>
      <Text style={styles.homeIntro}>
        {ways.mode === 'to-hub'
          ? 'Last way to Lerwick by public transport on this event day.'
          : 'Last way home by public transport on this event day.'}
      </Text>
      <View style={{ gap: 8 }}>
        {ways.options.map((o) => {
          const arrive = o.journey.legs[o.journey.legs.length - 1].arrive;
          return (
            <View key={o.area} style={styles.homeCard}>
              <View style={styles.homeHead}>
                <Text style={styles.homeArea}>{o.label}</Text>
                <View style={{ flexDirection: 'row', gap: 6, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {o.journey.needsBooking && (
                    <View style={styles.bookPill}><Text style={styles.bookPillText}>Ferry needs booking</Text></View>
                  )}
                  {o.leavesBeforeEnd && (
                    <View style={styles.bookPill}><Text style={styles.bookPillText}>Before event ends</Text></View>
                  )}
                </View>
              </View>
              <View style={styles.legFlow}>
                {o.journey.legs.map((leg, i) => (
                  <View key={i} style={styles.legChip}>
                    {i > 0 && <Text style={styles.legArrow}>→</Text>}
                    <FontAwesome5 name={leg.mode === 'ferry' ? 'ship' : 'bus'} size={10} color={colors.textSecondary} solid />
                    <Text style={styles.legTime}>{leg.depart}</Text>
                    <Text style={styles.legSvc}>{leg.service}</Text>
                  </View>
                ))}
                <Text style={styles.legArr}>→ arrives {arrive}</Text>
              </View>
            </View>
          );
        })}
      </View>
      <Text style={styles.caveat}>Timetabled connections — no live feed yet. Times can change; check before you travel. {FERRY_MORE_INFO}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Scarcity
  scarcity: { backgroundColor: AMBER_BG, borderRadius: radius.md, padding: 12, marginBottom: 12 },
  scarcityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scarcityBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scarcityBadgeText: { fontSize: fontSize.sm, fontWeight: '800', color: AMBER_TEXT },
  scarcityRight: { fontSize: fontSize.sm, fontWeight: '700', color: AMBER_TEXT },
  barTrack: { height: 6, borderRadius: 999, backgroundColor: '#FAC775', overflow: 'hidden', marginTop: 10 },
  barFill: { height: '100%', borderRadius: 999, backgroundColor: AMBER },
  recent: { fontSize: fontSize.xs, fontWeight: '600', color: AMBER_TEXT, marginTop: 8 },

  // Going pill
  goingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start',
    backgroundColor: colors.screenBackground, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: colors.border,
  },
  goingText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },

  // Getting there
  section: { marginTop: spacing.lg, paddingHorizontal: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary, marginBottom: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: {
    flexGrow: 1, flexBasis: '47%', minWidth: 140,
    backgroundColor: colors.cardBackground, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  cellLabel: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary, marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  cellValue: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary, marginTop: 2 },
  cellSub: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  caveat: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 10, lineHeight: 16 },

  // Getting home
  homeIntro: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: -6, marginBottom: 10 },
  ferryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  ferryCell: {
    flexGrow: 1, flexBasis: '30%', minWidth: 100,
    backgroundColor: colors.cardBackground, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  homeCard: { backgroundColor: colors.cardBackground, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12 },
  homeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  homeArea: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  bookPill: { backgroundColor: AMBER_BG, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  bookPillText: { fontSize: fontSize.xs, fontWeight: '700', color: AMBER_TEXT },
  legFlow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 },
  legChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legArrow: { fontSize: fontSize.sm, color: colors.textMuted, marginRight: 2 },
  legTime: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  legSvc: { fontSize: fontSize.sm, color: colors.textSecondary },
  legArr: { fontSize: fontSize.sm, color: colors.textMuted },
  homeWarn: { fontSize: fontSize.xs, fontWeight: '600', color: AMBER_TEXT, marginTop: 8 },
});
