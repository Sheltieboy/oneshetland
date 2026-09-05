/**
 * hub-membership-types.tsx
 * Hub owner/committee: create and manage membership tiers (Adult / Junior /
 * Family, Free / Paid, etc.). Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import * as WebBrowser from 'expo-web-browser';
import {
  fetchHub, fetchHubMembershipTypes, createMembershipType, updateMembershipType, deleteMembershipType,
  createHubOnboardingLink, fetchHubPayoutReady, formatMembershipPrice,
  type Hub, type HubMembershipType, type MembershipPeriod,
} from '@/lib/hubs-api';
import { hubPayoutNotice } from '@/lib/hub-payout-notice';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAlert } from '@/components/BrandedAlert';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { Sheet } from '@/components/ui/Sheet';

const S = SECTIONS.community;

const PERIODS: { key: MembershipPeriod; label: string }[] = [
  { key: 'year',  label: 'Per year' },
  { key: 'month', label: 'Per month' },
  { key: 'once',  label: 'One-off' },
];

interface FormState {
  id?: string;
  name: string;
  description: string;
  priceText: string;   // pounds, as typed
  period: MembershipPeriod;
  benefits: string;
}

const EMPTY: FormState = { name: '', description: '', priceText: '', period: 'year', benefits: '' };

export default function HubMembershipTypesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [hub, setHub] = useState<Hub | null>(null);
  const [types, setTypes] = useState<HubMembershipType[]>([]);
  // hub_payout_ready(): the hub's own connected account, payouts enabled. Not
  // hubs.payout_enabled, which can be true with no account attached — and the
  // account id itself is granted to no client role.
  const [payoutReady, setPayoutReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, t, ready] = await Promise.all([
        fetchHub(id),
        fetchHubMembershipTypes(id),
        fetchHubPayoutReady(id).catch(() => false),
      ]);
      setHub(h); setTypes(t); setPayoutReady(ready);
    } finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const openNew  = () => { setForm(EMPTY); setEditorOpen(true); };
  const openEdit = (t: HubMembershipType) => {
    setForm({
      id: t.id, name: t.name, description: t.description ?? '',
      priceText: t.price_pence ? (t.price_pence / 100).toString() : '',
      period: t.period, benefits: t.benefits ?? '',
    });
    setEditorOpen(true);
  };

  const save = async () => {
    if (!id) return;
    if (!form.name.trim()) { alert({ title: 'Name needed', message: 'Give this tier a name.' }); return; }
    const pricePence = Math.round((parseFloat(form.priceText) || 0) * 100);
    if (pricePence < 0) { alert({ title: 'Invalid price', message: 'Price cannot be negative.' }); return; }
    setSaving(true);
    const input = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price_pence: pricePence,
      period: form.period,
      benefits: form.benefits.trim() || null,
    };
    try {
      if (form.id) await updateMembershipType(form.id, input);
      else         await createMembershipType(id, input);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditorOpen(false);
      load();
    } catch (e: any) {
      alert({ title: 'Could not save', message: e?.message ?? '' });
    } finally { setSaving(false); }
  };

  const remove = (t: HubMembershipType) => {
    alert({
      title: 'Remove tier?',
      message: `"${t.name}" will be hidden. Existing members keep their membership.`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', onPress: async () => { try { await deleteMembershipType(t.id); load(); } catch (e: any) { alert({ title: 'Could not remove', message: e?.message ?? '' }); } } },
      ],
    });
  };

  const [onboarding, setOnboarding] = useState(false);
  // Shown whatever the tier list holds. The old gate was
  // `hasPaid && !hub.payout_enabled`, so a brand-new hub could design and save
  // a paid tier before anything mentioned that it could not be sold — and a hub
  // with no tiers at all was told nothing.
  const notice = hubPayoutNotice(payoutReady);

  const setUpPayouts = async () => {
    if (!id) return;
    setOnboarding(true);
    try {
      // Fresh link each tap (Stripe's expire), presented as an in-app sheet
      // rather than launching Safari — same mechanism as Hub → Payouts.
      const { url } = await createHubOnboardingLink(id);
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor:     S.color,
        toolbarColor:      '#ffffff',
        dismissButtonStyle:'close',
      });
      // Re-ask the database rather than assuming the sheet closing meant success.
      await load();
    } catch (e: any) {
      alert({ title: 'Could not start payout setup', message: e?.message ?? 'Please try again.' });
    } finally { setOnboarding(false); }
  };

  if (loading) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Membership tiers" accent={S.color} />}>
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Membership tiers"
          accent={S.color}
          rightElement={<IconButton icon="plus" color={S.color} onPress={openNew} accessibilityLabel="Add membership tier" />}
        />
      }
    >
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        <Text style={styles.intro}>
          Offer one or more ways to join — free or paid. Members choose a tier when they join.
        </Text>

        <View style={payoutReady ? styles.okCard : styles.warnCard}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <FontAwesome5
              name={payoutReady ? 'check-circle' : 'exclamation-circle'}
              size={14}
              color={payoutReady ? '#15803D' : '#B45309'}
              solid
              style={{ marginTop: 2 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={payoutReady ? styles.okTitle : styles.warnTitle}>{notice.title}</Text>
              <Text style={payoutReady ? styles.okText : styles.warnText}>{notice.body}</Text>
            </View>
          </View>
          {!payoutReady && (
            <TouchableOpacity style={styles.payoutBtn} onPress={setUpPayouts} disabled={onboarding} activeOpacity={0.85}>
              {onboarding ? <ActivityIndicator color="#fff" size="small" /> : (
                <>
                  <FontAwesome5 name="university" size={12} color="#fff" solid />
                  <Text style={styles.payoutBtnText}>{notice.cta}</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {types.length === 0 ? (
          <EmptyState
            icon="id-card"
            title="No tiers yet"
            body="Add your first membership tier."
            accent={S.color}
            variant="card"
          />
        ) : types.map(t => (
          <TouchableOpacity key={t.id} style={styles.tierCard} onPress={() => openEdit(t)} activeOpacity={0.8}>
            <View style={{ flex: 1 }}>
              <Text style={styles.tierName}>{t.name}</Text>
              {t.description ? <Text style={styles.tierDesc} numberOfLines={2}>{t.description}</Text> : null}
            </View>
            <View style={styles.tierRight}>
              <Text style={[styles.tierPrice, { color: t.price_pence ? S.color : colors.textMuted }]}>
                {formatMembershipPrice(t.price_pence, t.period)}
              </Text>
              <TouchableOpacity onPress={() => remove(t)} hitSlop={8} style={styles.tierDel}>
                <FontAwesome5 name="trash-alt" size={12} color={colors.textLight} />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        ))}

        <Button
          label="Add a tier"
          icon="plus"
          color={S.color}
          fullWidth
          onPress={openNew}
          style={styles.addBtnSpacing}
        />
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Editor sheet */}
      <Sheet
        visible={editorOpen}
        onClose={() => !saving && setEditorOpen(false)}
        title={form.id ? 'Edit tier' : 'New tier'}
        maxHeightPct={0.88}
      >
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
          <Text style={styles.label}>Name</Text>
          <TextInput style={styles.input} value={form.name} onChangeText={v => setForm(f => ({ ...f, name: v }))}
            placeholder="e.g. Adult, Junior, Family" placeholderTextColor={colors.textLight} />

          <Text style={styles.label}>Price (£) — leave blank for free</Text>
          <TextInput style={styles.input} value={form.priceText} onChangeText={v => setForm(f => ({ ...f, priceText: v.replace(/[^0-9.]/g, '') }))}
            placeholder="0.00" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />

          <Text style={styles.label}>Period</Text>
          <View style={styles.periodRow}>
            {PERIODS.map(p => (
              <TouchableOpacity key={p.key}
                style={[styles.periodBtn, form.period === p.key && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => setForm(f => ({ ...f, period: p.key }))} activeOpacity={0.8}>
                <Text style={[styles.periodText, form.period === p.key && { color: '#fff' }]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Description</Text>
          <TextInput style={[styles.input, styles.textarea]} value={form.description} onChangeText={v => setForm(f => ({ ...f, description: v }))}
            placeholder="Who is this tier for?" placeholderTextColor={colors.textLight} multiline />

          <Text style={styles.label}>Benefits</Text>
          <TextInput style={[styles.input, styles.textarea]} value={form.benefits} onChangeText={v => setForm(f => ({ ...f, benefits: v }))}
            placeholder="What members get (one per line)" placeholderTextColor={colors.textLight} multiline />

          <TouchableOpacity style={[styles.saveBtn, { backgroundColor: S.color }, saving && { opacity: 0.6 }]}
            onPress={save} disabled={saving} activeOpacity={0.85}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{form.id ? 'Save tier' : 'Add tier'}</Text>}
          </TouchableOpacity>
          <View style={{ height: 24 }} />
        </ScrollView>
      </Sheet>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  intro: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 21, marginBottom: spacing.md },

  warnCard: { backgroundColor: '#FEF3C7', borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, gap: 12 },
  warnTitle: { fontSize: fontSize.sm, fontWeight: '800', color: '#92400E', marginBottom: 2 },
  warnText: { fontSize: fontSize.xs, color: '#92400E', lineHeight: 18 },
  payoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#B45309', borderRadius: radius.md, paddingVertical: 11 },
  payoutBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  okCard: { backgroundColor: '#DCFCE7', borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, gap: 12 },
  okTitle: { fontSize: fontSize.sm, fontWeight: '800', color: '#166534', marginBottom: 2 },
  okText: { fontSize: fontSize.xs, color: '#166534', lineHeight: 18 },

  tierCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: 10 },
  tierName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  tierDesc: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  tierRight: { alignItems: 'flex-end', gap: 8 },
  tierPrice: { fontSize: fontSize.sm, fontWeight: '800' },
  tierDel: { padding: 4 },

  addBtnSpacing: { marginTop: 4 },

  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.md },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary },
  textarea: { minHeight: 70, textAlignVertical: 'top' },
  periodRow: { flexDirection: 'row', gap: 8 },
  periodBtn: { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  periodText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },

  saveBtn: { marginTop: spacing.lg, borderRadius: radius.lg, paddingVertical: 15, alignItems: 'center' },
  saveText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
