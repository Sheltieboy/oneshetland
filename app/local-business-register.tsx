/**
 * local-business-register.tsx
 * Create or edit your local business profile.
 * Pass ?id=xyz to edit, omit to create.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchBusiness, createBusiness, updateBusiness,
  CATEGORY_LABELS,
  type LocalCategory, type BusinessUpsertInput,
} from '@/lib/local-api';

const S = SECTIONS.local;
const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? '';

const CATEGORIES: { id: LocalCategory; label: string; icon: string }[] = [
  { id: 'food_drink',    label: 'Food & Drink',  icon: 'utensils' },
  { id: 'retail',        label: 'Retail',        icon: 'shopping-bag' },
  { id: 'services',      label: 'Services',      icon: 'tools' },
  { id: 'tourism',       label: 'Tourism',       icon: 'umbrella-beach' },
  { id: 'accommodation', label: 'Accommodation', icon: 'bed' },
  { id: 'other',         label: 'Other',         icon: 'store' },
];

export default function BusinessRegisterScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [name, setName]           = useState('');
  const [category, setCategory]   = useState<LocalCategory | null>(null);
  const [description, setDescription] = useState('');
  const [address, setAddress]     = useState('');
  const [lat, setLat]             = useState<number | null>(null);
  const [lng, setLng]             = useState<number | null>(null);
  const [phone, setPhone]         = useState('');
  const [website, setWebsite]     = useState('');
  const [email, setEmail]         = useState('');

  // Payment / payout overrides — both off by default (use central card/bank)
  const [useBusinessPayment, setUseBusinessPayment] = useState(false);
  const [useBusinessPayout,  setUseBusinessPayout]  = useState(false);

  const [loading, setLoading]     = useState(!!id);
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    if (!id) return;
    fetchBusiness(id).then(b => {
      if (b) {
        setName(b.name);
        setCategory(b.category);
        setDescription(b.description ?? '');
        setAddress(b.address);
        setLat(b.lat);
        setLng(b.lng);
        setPhone(b.phone ?? '');
        setWebsite(b.website ?? '');
        setEmail(b.email ?? '');
        setUseBusinessPayment((b as any).use_business_payment ?? false);
        setUseBusinessPayout((b as any).use_business_payout  ?? false);
      }
      setLoading(false);
    });
  }, [id]);

  const handleSave = async () => {
    if (!profile) return;
    if (!name.trim())  return Alert.alert('Name required', 'Please enter your business name.');
    if (!category)     return Alert.alert('Category required', 'Pick a category.');
    if (!address.trim()) return Alert.alert('Address required', 'Pick your address from the dropdown.');

    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const payload: BusinessUpsertInput = {
      name: name.trim(),
      category,
      description: description.trim() || null,
      address: address.trim(),
      lat, lng,
      phone:   phone.trim()   || null,
      website: website.trim() || null,
      email:   email.trim()   || null,
      use_business_payment: useBusinessPayment,
      use_business_payout:  useBusinessPayout,
    };

    try {
      if (id) {
        await updateBusiness(id, payload);
      } else {
        await createBusiness(profile.id, payload);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        id ? 'Saved' : 'Business listed!',
        id ? 'Your changes are live.' : 'Your business is now visible in the Local directory.',
        [{ text: 'OK', onPress: () => router.replace('/local-business-dashboard') }],
      );
    } catch (e: any) {
      Alert.alert('Could not save', e.message ?? 'Try again');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  // Safety net: if the user reached this screen without auth (deep link,
  // manual nav), prompt them to sign in rather than presenting a form
  // they can't actually submit.
  if (!profile) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={[styles.header, { borderBottomColor: S.color }]}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={14} color={S.color} />
            <Text style={[styles.backText, { color: S.color }]}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>List your business</Text>
          <View style={{ width: 70 }} />
        </View>
        <View style={[styles.center, { padding: spacing.xl, gap: 14 }]}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }}>
            <FontAwesome5 name="store" size={28} color={S.color} solid />
          </View>
          <Text style={{ fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' }}>
            Sign in to list your business
          </Text>
          <Text style={{ fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 21 }}>
            You'll need an account so we can save your business profile to you.
          </Text>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: S.color, paddingHorizontal: 22, paddingVertical: 13, borderRadius: radius.full, marginTop: 8 }}
            onPress={() => router.replace({ pathname: '/(auth)/sign-in', params: { next: '/local-business-register' } })}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="sign-in-alt" size={12} color="#fff" />
            <Text style={{ color: '#fff', fontSize: fontSize.sm, fontWeight: '800' }}>Sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{id ? 'Edit business' : 'List your business'}</Text>
        <View style={{ width: 70 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Business name *</Text>
            <TextInput
              style={styles.input}
              value={name} onChangeText={setName}
              placeholder="e.g. Fjårå Café Bar"
              placeholderTextColor={colors.textLight}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Category *</Text>
            <View style={styles.categoryGrid}>
              {CATEGORIES.map(c => {
                const active = category === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={[styles.categoryBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => { Haptics.selectionAsync(); setCategory(c.id); }}
                    activeOpacity={0.75}
                  >
                    <FontAwesome5 name={c.icon as any} size={14} color={active ? '#fff' : S.color} solid />
                    <Text style={[styles.categoryText, active && { color: '#fff' }]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Address *</Text>
            {GOOGLE_KEY ? (
              <View style={{ zIndex: 10 }}>
                <GooglePlacesAutocomplete
                  placeholder={address || 'Start typing your address…'}
                  minLength={3}
                  onPress={(data, details = null) => {
                    setAddress(data.description);
                    if (details?.geometry?.location) {
                      setLat(details.geometry.location.lat);
                      setLng(details.geometry.location.lng);
                    }
                  }}
                  query={{
                    key: GOOGLE_KEY,
                    language: 'en',
                    components: 'country:gb',
                    location: '60.3,-1.2',
                    radius: '50000',
                  }}
                  fetchDetails
                  textInputProps={{
                    placeholderTextColor: address ? colors.textPrimary : colors.textLight,
                  }}
                  styles={{
                    container: { flex: 0 },
                    textInput: styles.input,
                    listView: { backgroundColor: '#fff', borderRadius: radius.md, marginTop: 4 },
                  }}
                  enablePoweredByContainer={false}
                  debounce={250}
                />
              </View>
            ) : (
              <TextInput
                style={styles.input}
                value={address} onChangeText={setAddress}
                placeholder="Street, town, postcode"
                placeholderTextColor={colors.textLight}
              />
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>About</Text>
            <TextInput
              style={[styles.input, { height: 90, textAlignVertical: 'top' }]}
              value={description} onChangeText={setDescription}
              placeholder="What makes your business special? What do you offer?"
              placeholderTextColor={colors.textLight}
              multiline
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Phone</Text>
            <TextInput
              style={styles.input}
              value={phone} onChangeText={setPhone}
              placeholder="01595 ..."
              placeholderTextColor={colors.textLight}
              keyboardType="phone-pad"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Website</Text>
            <TextInput
              style={styles.input}
              value={website} onChangeText={setWebsite}
              placeholder="https://..."
              placeholderTextColor={colors.textLight}
              autoCapitalize="none"
              keyboardType="url"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Business email</Text>
            <TextInput
              style={styles.input}
              value={email} onChangeText={setEmail}
              placeholder="hello@yourbusiness.co.uk"
              placeholderTextColor={colors.textLight}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Text style={styles.fieldHint}>Used for Stripe payouts and account verification</Text>
          </View>

          {/* ── Payment & Payout setup ──────────────────────────────────────── */}
          <View style={styles.paymentSection}>
            <Text style={styles.paymentSectionTitle}>Payments & Payouts</Text>
            <Text style={styles.paymentSectionSub}>
              By default this business uses your central OneShetland payment card and bank account.
              Turn on a toggle to set up separate payment details for this business only.
            </Text>

            {/* Payment card toggle */}
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Business payment card</Text>
                <Text style={styles.toggleSub}>
                  {useBusinessPayment
                    ? 'Using a separate card for this business — set up in Payments & Banking after saving'
                    : 'Using your central OneShetland payment card'}
                </Text>
              </View>
              <Switch
                value={useBusinessPayment}
                onValueChange={v => { Haptics.selectionAsync(); setUseBusinessPayment(v); }}
                trackColor={{ false: colors.border, true: S.color + '55' }}
                thumbColor={useBusinessPayment ? S.color : '#fff'}
              />
            </View>

            {/* Payout bank toggle */}
            <View style={[styles.toggleRow, { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Business bank account</Text>
                <Text style={styles.toggleSub}>
                  {useBusinessPayout
                    ? 'Using a separate bank account for payouts — connect it in Payments & Banking after saving'
                    : 'Using your central OneShetland bank account'}
                </Text>
              </View>
              <Switch
                value={useBusinessPayout}
                onValueChange={v => { Haptics.selectionAsync(); setUseBusinessPayout(v); }}
                trackColor={{ false: colors.border, true: S.color + '55' }}
                thumbColor={useBusinessPayout ? S.color : '#fff'}
              />
            </View>
          </View>

          <TouchableOpacity
            style={[styles.saveBtn, { backgroundColor: S.color }, saving && { opacity: 0.7 }]}
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.85}
          >
            {saving
              ? <ActivityIndicator color="#fff" />
              : <>
                  <FontAwesome5 name="check" size={14} color="#fff" solid />
                  <Text style={styles.saveBtnText}>{id ? 'Save changes' : 'List my business'}</Text>
                </>
            }
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },

  // Payment section
  paymentSection: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 2,
  },
  paymentSectionTitle: {
    fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary, marginBottom: 4,
  },
  paymentSectionSub: {
    fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17, marginBottom: spacing.sm,
  },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  toggleLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  toggleSub:   { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },

  field:      {},
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  fieldHint:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 4 },
  input: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 12,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },

  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
  },
  categoryText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },

  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, borderRadius: radius.lg, marginTop: 12,
  },
  saveBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
