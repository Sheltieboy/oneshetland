/**
 * (admin)/compliance.tsx
 *
 * Admin compliance audit log.
 * Search by member email to see every verification, agreement and consent
 * they have given — date/time stamped and immutable.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { supabase } from '@/lib/supabase';
import { COMPLIANCE_EVENT_LABELS, type ComplianceEventType } from '@/lib/compliance';

const EVENT_ICONS: Partial<Record<ComplianceEventType, string>> = {
  'email.verified':        'envelope-open-text',
  'terms.accepted':        'file-contract',
  'privacy.accepted':      'shield-alt',
  'fetch.liability_ack':   'truck',
  'driver.terms_accepted': 'id-card',
  'marketing.opted_in':    'bell',
  'marketing.opted_out':   'bell-slash',
  'data.export_requested': 'download',
  'account.deletion_req':  'user-times',
  'age.confirmed':         'birthday-cake',
  'booking.terms_accepted':'calendar-check',
  'payment.method_added':  'credit-card',
  'password.changed':      'key',
  'email.changed':         'at',
};

const EVENT_COLORS: Partial<Record<ComplianceEventType, string>> = {
  'email.verified':        '#10B981',
  'terms.accepted':        '#7C3AED',
  'privacy.accepted':      '#7C3AED',
  'fetch.liability_ack':   '#E0722A',
  'driver.terms_accepted': '#E0722A',
  'marketing.opted_in':    '#10B981',
  'marketing.opted_out':   '#6B7280',
  'data.export_requested': '#3B82F6',
  'account.deletion_req':  '#DC2626',
  'age.confirmed':         '#10B981',
  'booking.terms_accepted':'#7C3AED',
  'payment.method_added':  '#E8A020',
  'password.changed':      '#DC2626',
  'email.changed':         '#DC2626',
};

interface ComplianceEntry {
  id:               string;
  user_id:          string | null;
  user_email:       string;
  user_name:        string | null;
  event_type:       ComplianceEventType;
  document_version: string | null;
  description:      string | null;
  ip_address:       string | null;
  device_info:      string | null;
  app_version:      string | null;
  metadata:         Record<string, unknown>;
  created_at:       string;
}

export default function ComplianceScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [searchEmail, setSearchEmail] = useState('');
  const [results,     setResults]     = useState<ComplianceEntry[] | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [searched,    setSearched]    = useState(false);
  const [expanded,    setExpanded]    = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    const q = searchEmail.trim().toLowerCase();
    if (!q) {
      alert({ title: 'Enter an email', message: 'Type a member email address to search.' });
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLoading(true);
    setSearched(true);
    setResults(null);
    try {
      const { data, error } = await supabase
        .from('compliance_log')
        .select('*')
        .ilike('user_email', `%${q}%`)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setResults((data ?? []) as ComplianceEntry[]);
    } catch (e: any) {
      alert({ title: 'Search failed', message: e?.message ?? 'Try again.' });
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [searchEmail]);

  // Group results by date
  const grouped = results ? results.reduce<Record<string, ComplianceEntry[]>>((acc, r) => {
    const day = new Date(r.created_at).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    if (!acc[day]) acc[day] = [];
    acc[day].push(r);
    return acc;
  }, {}) : {};

  const user = results?.[0];

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Compliance Log"
          accent={colors.accent}
          onBack={() => router.back()}
        />
      }
    >
      {/* Search */}
      <View style={styles.searchBar}>
        <FontAwesome5 name="search" size={13} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={searchEmail}
          onChangeText={setSearchEmail}
          placeholder="Search by member email..."
          placeholderTextColor={colors.textLight}
          autoCapitalize="none"
          keyboardType="email-address"
          returnKeyType="search"
          onSubmitEditing={handleSearch}
          autoCorrect={false}
        />
        {searchEmail.length > 0 && (
          <TouchableOpacity onPress={() => { setSearchEmail(''); setResults(null); setSearched(false); }} hitSlop={8}>
            <FontAwesome5 name="times-circle" size={14} color={colors.textLight} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.searchBtn}
          onPress={handleSearch}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={styles.searchBtnText}>Search</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">

        {/* Not searched yet */}
        {!searched && (
          <View style={styles.placeholder}>
            <View style={styles.placeholderIcon}>
              <FontAwesome5 name="shield-alt" size={28} color={colors.textLight} />
            </View>
            <Text style={styles.placeholderTitle}>Compliance Audit Log</Text>
            <Text style={styles.placeholderSub}>
              Search a member's email to view every verification, agreement and
              consent they have given — fully timestamped and immutable.
            </Text>

            <View style={styles.legendCard}>
              <Text style={styles.legendTitle}>Tracked events</Text>
              {(Object.entries(COMPLIANCE_EVENT_LABELS) as [ComplianceEventType, string][]).map(([key, label]) => (
                <View key={key} style={styles.legendRow}>
                  <View style={[styles.legendDot, { backgroundColor: EVENT_COLORS[key] ?? colors.textLight }]} />
                  <Text style={styles.legendLabel}>{label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Loading */}
        {loading && (
          <LoadingState accent={colors.accent} />
        )}

        {/* Results */}
        {!loading && results !== null && (
          <>
            {/* User summary card */}
            {user && (
              <View style={styles.userCard}>
                <View style={styles.userCardIcon}>
                  <Text style={styles.userCardInitial}>
                    {(user.user_name ?? user.user_email)[0].toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName}>{user.user_name ?? 'Unknown'}</Text>
                  <Text style={styles.userEmail}>{user.user_email}</Text>
                </View>
                <View style={styles.userCount}>
                  <Text style={styles.userCountNum}>{results.length}</Text>
                  <Text style={styles.userCountLabel}>records</Text>
                </View>
              </View>
            )}

            {/* No results */}
            {results.length === 0 && (
              <EmptyState
                icon="search"
                title="No records found"
                body="No compliance events logged for this email address."
                accent={colors.accent}
                variant="card"
              />
            )}

            {/* Grouped records */}
            {Object.entries(grouped).map(([day, entries]) => (
              <View key={day} style={styles.dayGroup}>
                <Text style={styles.dayLabel}>{day}</Text>

                {entries.map(entry => {
                  const isExpanded = expanded === entry.id;
                  const color = EVENT_COLORS[entry.event_type] ?? colors.textMuted;
                  const icon  = EVENT_ICONS[entry.event_type] ?? 'check-circle';
                  const label = COMPLIANCE_EVENT_LABELS[entry.event_type] ?? entry.event_type;

                  return (
                    <TouchableOpacity
                      key={entry.id}
                      style={styles.entryCard}
                      onPress={() => { Haptics.selectionAsync(); setExpanded(isExpanded ? null : entry.id); }}
                      activeOpacity={0.8}
                    >
                      {/* Main row */}
                      <View style={styles.entryRow}>
                        <View style={[styles.entryIcon, { backgroundColor: color + '18' }]}>
                          <FontAwesome5 name={icon as any} size={13} color={color} solid />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.entryLabel}>{label}</Text>
                          {entry.document_version && (
                            <Text style={styles.entryVersion}>Version {entry.document_version}</Text>
                          )}
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 2 }}>
                          <Text style={styles.entryTime}>
                            {new Date(entry.created_at).toLocaleTimeString('en-GB', {
                              hour: '2-digit', minute: '2-digit', second: '2-digit',
                            })}
                          </Text>
                          <FontAwesome5 name={isExpanded ? 'chevron-up' : 'chevron-down'} size={9} color={colors.textLight} />
                        </View>
                      </View>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <View style={styles.entryDetail}>
                          {[
                            { label: 'Record ID',    value: entry.id },
                            { label: 'User ID',      value: entry.user_id ?? '—' },
                            { label: 'Email',        value: entry.user_email },
                            { label: 'Name',         value: entry.user_name ?? '—' },
                            { label: 'Event',        value: entry.event_type },
                            { label: 'Version',      value: entry.document_version ?? '—' },
                            { label: 'Description',  value: entry.description ?? '—' },
                            { label: 'IP address',   value: entry.ip_address ?? '—' },
                            { label: 'Device',       value: entry.device_info ?? '—' },
                            { label: 'App version',  value: entry.app_version ?? '—' },
                            { label: 'Timestamp',    value: new Date(entry.created_at).toISOString() },
                          ].map(({ label: l, value: v }) => (
                            <View key={l} style={styles.detailRow}>
                              <Text style={styles.detailLabel}>{l}</Text>
                              <Text style={styles.detailValue} selectable>{v}</Text>
                            </View>
                          ))}

                          {Object.keys(entry.metadata).length > 0 && (
                            <View style={styles.detailRow}>
                              <Text style={styles.detailLabel}>Metadata</Text>
                              <Text style={styles.detailValue} selectable>
                                {JSON.stringify(entry.metadata, null, 2)}
                              </Text>
                            </View>
                          )}

                          <View style={[styles.immutableBadge]}>
                            <FontAwesome5 name="lock" size={10} color="#7C3AED" solid />
                            <Text style={styles.immutableText}>
                              This record is immutable — it cannot be edited or deleted
                            </Text>
                          </View>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1, fontSize: fontSize.sm, color: colors.textPrimary,
  },
  searchBtn: {
    backgroundColor: colors.navy, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full,
  },
  searchBtnText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },

  // Placeholder
  placeholder:      { alignItems: 'center', paddingVertical: spacing.xl },
  placeholderIcon:  { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  placeholderTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  placeholderSub:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20, paddingHorizontal: spacing.lg, marginBottom: spacing.lg },

  legendCard:  { width: '100%', backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  legendTitle: { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary, marginBottom: 10 },
  legendRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  legendDot:   { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600' },

  // User card
  userCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.navy, borderRadius: radius.lg,
    padding: 14, marginBottom: spacing.md,
  },
  userCardIcon:    { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  userCardInitial: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  userName:        { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  userEmail:       { color: 'rgba(255,255,255,0.65)', fontSize: fontSize.xs, marginTop: 2 },
  userCount:       { alignItems: 'center' },
  userCountNum:    { color: '#fff', fontSize: fontSize.xl, fontWeight: '900' },
  userCountLabel:  { color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '700' },

  // Day group
  dayGroup:  { marginBottom: spacing.md },
  dayLabel:  { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm },

  // Entry card
  entryCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 8, overflow: 'hidden',
  },
  entryRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  entryIcon:   { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  entryLabel:  { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  entryVersion:{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  entryTime:   { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  // Expanded detail
  entryDetail: {
    borderTopWidth: 1, borderTopColor: colors.border,
    padding: 12, gap: 6,
  },
  detailRow:   { flexDirection: 'row', gap: 8, paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { width: 90, fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, flexShrink: 0 },
  detailValue: { flex: 1, fontSize: fontSize.xs, color: colors.textPrimary, fontFamily: 'Courier', lineHeight: 17 },

  immutableBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: '#F3E8FF', borderRadius: radius.md,
    paddingHorizontal: 10, paddingVertical: 7, marginTop: 8,
  },
  immutableText: { fontSize: fontSize.xs, color: '#7C3AED', fontWeight: '700', flex: 1 },
});
