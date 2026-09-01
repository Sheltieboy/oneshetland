/**
 * local-business-register.tsx
 * Create or edit your local business profile.
 * Pass ?id=xyz to edit, omit to create.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, Switch,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { useAuth } from '@/context/AuthContext';
import {
  fetchBusiness, createBusiness, updateBusiness,
  CATEGORY_LABELS, TRADE_TAGS,
  type LocalCategory, type BusinessUpsertInput,
} from '@/lib/local-api';
import { uploadBusinessImage, extractBrandColor, type PickedFile } from '@/lib/image-upload';
import { track } from '@/lib/analytics';
import { OpeningHoursEditor } from '@/components/business/OpeningHoursEditor';
import { PlannerContextEditor } from '@/components/business/PlannerContextEditor';
import {
  EMPTY_PLANNER_CONTEXT, hasPlannerContext, type PlannerContext,
} from '@/constants/planner-context';
import { hasAnyHours, DAYS, type OpeningHoursMap } from '@/lib/opening-hours';

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

/**
 * A week in one line. Runs of identical days are collapsed, so the common case
 * reads "Mon–Fri 09:00–17:00 · Sat 10:00–16:00 · Sun closed" rather than seven
 * rows. Purely presentational: the stored shape and every rule about Closed,
 * Not set and after-midnight belong to OpeningHoursEditor and are untouched.
 */
function summariseHours(hours: OpeningHoursMap | null | undefined): string {
  if (!hasAnyHours(hours)) return 'Not set';
  const parts: string[] = [];
  let runStart = 0;
  for (let i = 0; i <= DAYS.length; i++) {
    const prev = hours?.[DAYS[i - 1]?.key];
    const cur  = i < DAYS.length ? hours?.[DAYS[i].key] : Symbol('end') as unknown as string;
    if (i > 0 && cur !== prev) {
      const from = DAYS[runStart].short, to = DAYS[i - 1].short;
      const label = from === to ? from : `${from}–${to}`;
      parts.push(`${label} ${prev ? prev : 'not set'}`);
      runStart = i;
    }
  }
  return parts.join(' · ');
}

export default function BusinessRegisterScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { alert } = useAlert();

  const [name, setName]           = useState('');
  const [category, setCategory]   = useState<LocalCategory | null>(null);
  const [description, setDescription] = useState('');
  const [address, setAddress]     = useState('');
  const [lat, setLat]             = useState<number | null>(null);
  const [lng, setLng]             = useState<number | null>(null);
  const [phone, setPhone]         = useState('');
  const [website, setWebsite]     = useState('');
  const [email, setEmail]         = useState('');

  // Logo + brand colour. logoUrl = already-saved URL; logoFile = freshly picked
  // local file pending upload on save.
  const [logoUrl, setLogoUrl]     = useState<string | null>(null);
  const [logoFile, setLogoFile]   = useState<PickedFile | null>(null);
  const [brandColor, setBrandColor] = useState<string | null>(null);
  const [tags, setTags]           = useState<string[]>([]);

  /* Progressive disclosure. Hours, services and the visitor questions are all
     real work, but they are not what somebody opening "Edit business" is
     usually here to do — and rendering all three in full turned the primary
     job, the profile, into something you scroll past. Each shows what it holds
     and opens in place.

     `focus` lets NEXT land the owner on the right one: being told to add
     opening hours and then dropped at the top of a long form is the same
     failure in a different place. */
  const focus = useLocalSearchParams<{ focus?: string }>().focus;
  /* Where each block ended up, recorded by the layout pass itself. No pixel
     offsets and no persisted state: onLayout reports the real y, and NEXT
     scrolls to the one it asked about. Opened with no focus, nothing happens
     and the screen starts at the top as usual. */
  const scroller = useRef<ScrollView>(null);
  const spots = useRef<Record<string, number>>({});
  const onLayout = (key: string) => (e: LayoutChangeEvent) => {
    spots.current[key] = e.nativeEvent.layout.y;
    if (key === focus) {
      // A little headroom, so the label is not flush against the top.
      scroller.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 16), animated: true });
    }
  };

  const [open, setOpen] = useState({
    hours:    focus === 'opening_hours',
    offer:    false,
    visitors: false,
  });

  const [customTag, setCustomTag] = useState('');
  const [hours, setHours]         = useState<OpeningHoursMap>({});
  const [planner, setPlanner]     = useState<PlannerContext>(EMPTY_PLANNER_CONTEXT);

  /** What each collapsed section says it holds. Never a count of what is missing. */
  const hoursSummary = summariseHours(hours);
  const offerSummary = tags.length === 0
    ? 'Nothing selected'
    : tags.length <= 3
      ? tags.join(' · ')
      : `${tags.slice(0, 2).join(' · ')} · ${tags.length - 2} more`;
  const visitorSummary = hasPlannerContext(planner)
    ? 'Answered — helps visitors find you at the right time of day'
    : 'Optional — a few questions that put you in visitors\' plans';

  // Payment / payout overrides — both off by default (use central card/bank)

  const [loading, setLoading]     = useState(!!id);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);   // inline success state

  useEffect(() => {
    if (!id) return;
    fetchBusiness(id).then(async b => {
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
        setLogoUrl(b.logo_url ?? null);
        setBrandColor(b.brand_color ?? null);
        setTags(b.tags ?? []);
        setHours((b.opening_hours as OpeningHoursMap) ?? {});
        setPlanner({
          planner_visitor_ready: (b as any).planner_visitor_ready ?? null,
          planner_dwell_minutes: (b as any).planner_dwell_minutes ?? null,
          planner_setting:       (b as any).planner_setting ?? null,
          planner_good_for:      (b as any).planner_good_for ?? null,
          planner_booking:       (b as any).planner_booking ?? null,
          planner_note:          (b as any).planner_note ?? null,
        });
      }
      setLoading(false);
    });
  }, [id]);

  const pickLogo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return alert({ title: 'Permission needed', message: 'Allow photo access to add a logo.' });
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    Haptics.selectionAsync();
    setLogoFile({ uri: a.uri, mimeType: a.mimeType, ext: a.fileName?.split('.').pop() });
    // Preview immediately from the local file.
    setLogoUrl(a.uri);
    // Extract the dominant colour up-front so the owner can see the tint.
    const color = await extractBrandColor(a.uri);
    if (color) setBrandColor(color);
  };

  const toggleTag = (tag: string) => {
    Haptics.selectionAsync();
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const addCustomTag = () => {
    const t = customTag.trim();
    if (!t) return;
    if (!tags.some(x => x.toLowerCase() === t.toLowerCase())) setTags(prev => [...prev, t]);
    setCustomTag('');
  };

  const handleSave = async () => {
    if (!profile) return;
    if (!name.trim())  return alert({ title: 'Name required', message: 'Please enter your business name.' });
    if (!category)     return alert({ title: 'Category required', message: 'Pick a category.' });
    if (!address.trim()) return alert({ title: 'Address required', message: 'Pick your address from the dropdown.' });

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
      tags,
      opening_hours: hasAnyHours(hours) ? hours : null,
      // Only stamp the provenance when they've actually answered something.
      // 'owner' outranks every rule, inference and bulk-import guess, and the
      // backfill scripts refuse to touch a row carrying it — so writing it on
      // an untouched form would freeze our own guess as the owner's word.
      ...(hasPlannerContext(planner)
        ? { ...planner, planner_context_source: 'owner' as const }
        : {}),
    };

    try {
      let businessId = id;
      if (id) {
        await updateBusiness(id, payload);
      } else {
        const created = await createBusiness(profile.id, payload);
        businessId = created.id;
        track('business_created', { businessId: created.id });
      }

      // Upload a freshly-picked logo now that we have a business id, then
      // persist its URL + the extracted brand colour.
      if (logoFile && businessId) {
        try {
          const uploaded = await uploadBusinessImage(businessId, 'logo', logoFile);
          const color = brandColor ?? (await extractBrandColor(logoFile.uri));
          await updateBusiness(businessId, {
            logo_url: uploaded.publicUrl,
            brand_color: color ?? null,
          });
        } catch (imgErr: any) {
          // Don't fail the whole save if only the image upload hiccups.
          alert({ title: 'Logo not saved', message: imgErr?.message ?? 'The details saved, but the logo upload failed. Try again from Edit.' });
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Show success INLINE — this screen is presented as a modal and the alert
      // lives at the app root, so iOS can't present it over us (it's swallowed).
      setSaved(true);
    } catch (e: any) {
      alert({ title: 'Could not save', message: e.message ?? 'Try again' });
    } finally {
      setSaving(false);
    }
  };

  // ── Inline success screen (shown after save) ────────────────────────────────
  if (saved) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title={id ? 'Saved' : 'Business listed'} onClose={() => router.replace('/local-business-dashboard')} accent={S.color} />
        <View style={styles.successWrap}>
          <View style={[styles.successIcon, { backgroundColor: S.light }]}>
            <FontAwesome5 name="store" size={30} color={S.color} solid />
          </View>
          <Text style={styles.successTitle}>{id ? 'Changes saved ✓' : 'Business listed! 🎉'}</Text>
          <Text style={styles.successSub}>
            {id ? 'Your changes are live.' : 'Your business is now visible in the Local directory.'}
          </Text>
          <TouchableOpacity
            style={[styles.successBtn, { backgroundColor: S.color }]}
            onPress={() => router.replace('/local-business-dashboard')}
            activeOpacity={0.85}
          >
            <Text style={styles.successBtnText}>Go to dashboard</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

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
      <ScreenHeader
        title={id ? 'Edit business' : 'List your business'}
        onClose={() => router.back()}
        accent={S.color}
      />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView ref={scroller} style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">

          {/* Logo + auto-tinted banner preview */}
        {/* ── Profile & contact ────────────────────────────────────────
             Everything a customer needs, in one run, at the top. Contact
             details used to sit below the whole visitor questionnaire, so
             an owner sent here by "Add a way customers can contact you"
             arrived at a form and had to scroll past three other subjects
             to do the one thing they were asked to do. */}

          {/* A thumbnail and a line, not a hero. The upload, the brand-colour
              extraction and the tint are exactly as they were — this is the
              same control taking a fifth of the room. */}
          <View style={styles.field} onLayout={onLayout('image')}>
            <TouchableOpacity style={styles.logoRow} onPress={pickLogo} activeOpacity={0.7}>
              {logoUrl ? (
                <Image source={{ uri: logoUrl }} style={styles.logoThumb} />
              ) : (
                <View style={[styles.logoThumb, styles.logoPlaceholder, { backgroundColor: (brandColor ?? S.color) + '18' }]}>
                  <FontAwesome5 name="camera" size={16} color={S.color} solid />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Logo</Text>
                <Text style={styles.discloseSummary}>
                  {logoUrl ? 'Tap to change it' : 'Tap to add one'}
                  {brandColor ? '  ·  your colour comes from it' : ''}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

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

          <View style={styles.field} onLayout={onLayout('map_pin')}>
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

          {/* Phone, website and email together: NEXT sends people here by
              name, so they are one block and they are above the fold. */}
          <View style={styles.fieldGroup} onLayout={onLayout('contact')}>
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
          </View>

          <View style={styles.field} onLayout={onLayout('description')}>
            <Text style={styles.fieldLabel}>About</Text>
            <TextInput
              style={[styles.input, { height: 90, textAlignVertical: 'top' }]}
              value={description} onChangeText={setDescription}
              placeholder="What makes your business special? What do you offer?"
              placeholderTextColor={colors.textLight}
              multiline
            />
          </View>

        {/* Opening hours — summary by default; the real editor is one tap away. */}
        <View style={styles.field}>
          <TouchableOpacity style={styles.discloseRow} activeOpacity={0.7}
            onPress={() => setOpen(o => ({ ...o, hours: !o.hours }))}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Opening hours</Text>
              <Text style={styles.discloseSummary} numberOfLines={2}>{hoursSummary}</Text>
            </View>
            <FontAwesome5 name={open.hours ? "chevron-up" : "chevron-down"} size={13} color={S.color} />
          </TouchableOpacity>
        </View>
        {open.hours && (<>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Opening hours</Text>
            <Text style={styles.fieldHint}>
              Worth filling in properly — it&apos;s what puts you in a visitor&apos;s plan for the right part of
              the day, and stops folk turning up when you&apos;re shut.
            </Text>
            <OpeningHoursEditor value={hours} onChange={setHours} accent={S.color} />
          </View>
        </>)}

        {/* What you offer — summary by default; the real editor is one tap away. */}
        <View style={styles.field}>
          <TouchableOpacity style={styles.discloseRow} activeOpacity={0.7}
            onPress={() => setOpen(o => ({ ...o, offer: !o.offer }))}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>What you offer</Text>
              <Text style={styles.discloseSummary} numberOfLines={2}>{offerSummary}</Text>
            </View>
            <FontAwesome5 name={open.offer ? "chevron-up" : "chevron-down"} size={13} color={S.color} />
          </TouchableOpacity>
        </View>
        {open.offer && (<>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Services &amp; trades</Text>
            <Text style={styles.fieldHint}>
              Pick what you offer so customers find you when they search (e.g. “plumber”).
            </Text>

            {tags.length > 0 && (
              <View style={[styles.tagWrap, { marginTop: 10 }]}>
                {tags.map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tagChip, { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => toggleTag(t)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.tagChipText, { color: '#fff' }]}>{t}</Text>
                    <FontAwesome5 name="times" size={10} color="#fff" />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={[styles.tagWrap, { marginTop: 10 }]}>
              {TRADE_TAGS.filter(t => !tags.includes(t)).slice(0, 24).map(t => (
                <TouchableOpacity
                  key={t}
                  style={styles.tagChip}
                  onPress={() => toggleTag(t)}
                  activeOpacity={0.75}
                >
                  <FontAwesome5 name="plus" size={9} color={colors.textMuted} />
                  <Text style={styles.tagChipText}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.tagAddRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={customTag}
                onChangeText={setCustomTag}
                placeholder="Add your own…"
                placeholderTextColor={colors.textLight}
                returnKeyType="done"
                onSubmitEditing={addCustomTag}
              />
              <TouchableOpacity
                style={[styles.tagAddBtn, { backgroundColor: customTag.trim() ? S.color : colors.border }]}
                onPress={addCustomTag}
                disabled={!customTag.trim()}
              >
                <FontAwesome5 name="plus" size={13} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </>)}

        {/* For visitors — summary by default; the real editor is one tap away. */}
        <View style={styles.field}>
          <TouchableOpacity style={styles.discloseRow} activeOpacity={0.7}
            onPress={() => setOpen(o => ({ ...o, visitors: !o.visitors }))}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>For visitors</Text>
              <Text style={styles.discloseSummary} numberOfLines={2}>{visitorSummary}</Text>
            </View>
            <FontAwesome5 name={open.visitors ? "chevron-up" : "chevron-down"} size={13} color={S.color} />
          </TouchableOpacity>
        </View>
        {open.visitors && (<>
          <View style={styles.field}>
            <PlannerContextEditor value={planner} onChange={setPlanner} accent={S.color} />
          </View>
        </>)}

        {/* Payments and payouts are not profile. Both toggles already
            live in Money on Business Home, which is where the accepted
            architecture puts them and where the rest of the payout setup
            already is. This screen had a second copy of the same two
            settings; a duplicate is how two truths start. */}


          <Button
            label={id ? 'Save changes' : 'List my business'}
            icon="check"
            color={S.color}
            fullWidth
            loading={saving}
            disabled={saving}
            onPress={handleSave}
            style={styles.saveBtn}
          />

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
  /* Grouping the three contact fields for onLayout cost them the gap the
     ScrollView gives its direct children, so they sat flush against each
     other's inputs. Same token, restored one level down. */
  fieldGroup:      { gap: spacing.md },
  logoRow:         { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logoThumb:       { width: 48, height: 48, borderRadius: 12 },
  logoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  discloseRow:     { flexDirection: 'row', alignItems: 'center', gap: 12 },
  discloseSummary: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  fieldHint:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 4 },

  // Logo + banner preview
  input: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 12,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },

  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  tagChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },
  tagAddRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  tagAddBtn: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },

  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
  },
  categoryText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },

  saveBtn: {
    marginTop: spacing.lg,
  },

  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.screenBackground },
  successIcon: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
  },
  successTitle: { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  successSub: {
    fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center',
    paddingHorizontal: spacing.xl, lineHeight: 22, marginTop: spacing.sm,
  },
  successBtn: {
    marginTop: spacing.xl, borderRadius: radius.lg,
    paddingVertical: 15, paddingHorizontal: spacing.xxl, alignItems: 'center',
  },
  successBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
