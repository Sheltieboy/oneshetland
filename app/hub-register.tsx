/**
 * hub-register.tsx
 * Create or edit a Hub. Pass ?id=xyz to edit. Logo upload auto-extracts the
 * dominant colour into brand_color, which tints the public page banner + accents.
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { useAuth } from '@/context/AuthContext';
import { uploadHubImage, extractBrandColor, type PickedFile } from '@/lib/image-upload';
import {
  fetchHub, createHub, updateHub,
  HUB_TYPE_LABELS, HUB_TYPE_ICONS,
  type HubType, type JoinMode,
} from '@/lib/hubs-api';

const S = SECTIONS.community;

const TYPES: HubType[] = ['club', 'sports', 'youth', 'hall', 'charity', 'society', 'volunteer', 'arts', 'community', 'other'];
const PALETTE = ['#6B47BF', '#0E7490', '#2A8B5C', '#C2410C', '#9F1239', '#1E3A8A', '#B45309', '#475569'];

export default function HubRegisterScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [type, setType] = useState<HubType>('club');
  const [description, setDescription] = useState('');
  const [area, setArea] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [joinMode, setJoinMode] = useState<JoinMode>('approval');
  const [directoryEnabled, setDirectoryEnabled] = useState(false);
  const [isCharity, setIsCharity] = useState(false);
  const [charityNumber, setCharityNumber] = useState('');
  const [brandColor, setBrandColor] = useState<string>(PALETTE[0]);
  // logoUrl = preview/saved URL; logoFile = freshly picked file pending upload.
  const [logoUrl, setLogoUrl]   = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<PickedFile | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const h = await fetchHub(id);
        if (h) {
          setName(h.name); setType(h.type); setDescription(h.description ?? '');
          setArea(h.area ?? ''); setEmail(h.contact_email ?? ''); setPhone(h.contact_phone ?? '');
          setWebsite(h.website ?? ''); setJoinMode(h.join_mode);
          setDirectoryEnabled(h.directory_enabled);
          setIsCharity(h.is_charity); setCharityNumber(h.charity_number ?? '');
          setLogoUrl(h.logo_url ?? null);
          if (h.brand_color) setBrandColor(h.brand_color);
        }
      } finally { setLoading(false); }
    })();
  }, [id]);

  const pickLogo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return alert({ title: 'Permission needed', message: 'Allow photo access to add a logo.' });
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    Haptics.selectionAsync();
    setLogoFile({ uri: a.uri, mimeType: a.mimeType, ext: a.fileName?.split('.').pop() });
    setLogoUrl(a.uri); // local preview
    // Auto-tint: take the dominant colour from the logo so the banner + accents match.
    const color = await extractBrandColor(a.uri);
    if (color) setBrandColor(color);
  };

  const save = async () => {
    if (!profile) { router.push('/(auth)/sign-in'); return; }
    if (!name.trim()) { alert({ title: 'Name needed', message: 'Give your hub a name.' }); return; }
    setSaving(true);
    const input = {
      name: name.trim(), type, description: description.trim() || null,
      area: area.trim() || null, contact_email: email.trim() || null,
      contact_phone: phone.trim() || null, website: website.trim() || null,
      join_mode: joinMode, brand_color: brandColor, directory_enabled: directoryEnabled,
      is_charity: isCharity, charity_number: isCharity ? (charityNumber.trim() || null) : null,
    };
    try {
      let hubId = id;
      if (id) await updateHub(id, input);
      else    { const hub = await createHub(profile.id, input); hubId = hub.id; }

      // Upload a freshly-picked logo now that we have a hub id, then persist its
      // URL + the extracted brand colour.
      if (logoFile && hubId) {
        try {
          const uploaded = await uploadHubImage(hubId, 'logo', logoFile);
          const color = brandColor ?? (await extractBrandColor(logoFile.uri));
          await updateHub(hubId, { logo_url: uploaded.publicUrl, brand_color: color ?? null });
        } catch (imgErr: any) {
          alert({ title: 'Logo not saved', message: imgErr?.message ?? 'The details saved, but the logo upload failed — try again from settings.' });
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (id) router.back();
      else    router.replace(`/hubs/${hubId}`);
    } catch (e: any) {
      alert({ title: 'Could not save', message: e?.message ?? 'Please try again.' });
    } finally { setSaving(false); }
  };

  if (loading) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><ActivityIndicator color={S.color} /></View></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title={id ? 'Edit hub' : 'Start a hub'} onClose={() => router.back()} accent={S.color} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">

          {/* Logo — banner preview tints to the logo's dominant colour */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Logo</Text>
            <View style={[styles.logoBanner, { backgroundColor: brandColor }]}>
              <TouchableOpacity style={styles.logoPick} onPress={pickLogo} activeOpacity={0.85}>
                {logoUrl ? (
                  <Image source={{ uri: logoUrl }} style={styles.logoImg} />
                ) : (
                  <View style={[styles.logoImg, styles.logoPlaceholder]}>
                    <FontAwesome5 name="camera" size={20} color={brandColor} solid />
                  </View>
                )}
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={pickLogo} activeOpacity={0.7}>
              <Text style={styles.logoHint}>
                {logoUrl ? 'Tap the logo to change it' : 'Tap to add a logo'}
                {logoFile ? '  ·  banner & accents tinted from your logo' : ''}
              </Text>
            </TouchableOpacity>
          </View>

          <Field label="Hub name *">
            <TextInput style={styles.input} value={name} onChangeText={setName}
              placeholder="e.g. Burra Youth Club" placeholderTextColor={colors.textLight} />
          </Field>

          <Field label="Type">
            <View style={styles.typeGrid}>
              {TYPES.map(t => {
                const active = type === t;
                return (
                  <TouchableOpacity key={t} style={[styles.typeBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => { Haptics.selectionAsync(); setType(t); }} activeOpacity={0.8}>
                    <FontAwesome5 name={(HUB_TYPE_ICONS[t]) as any} size={12} color={active ? '#fff' : S.color} solid />
                    <Text style={[styles.typeText, active && { color: '#fff' }]}>{HUB_TYPE_LABELS[t]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Field>

          <Field label="Brand colour">
            <View style={styles.paletteRow}>
              {PALETTE.map(c => (
                <TouchableOpacity key={c} onPress={() => setBrandColor(c)} activeOpacity={0.8}
                  style={[styles.swatch, { backgroundColor: c }, brandColor === c && styles.swatchActive]}>
                  {brandColor === c && <FontAwesome5 name="check" size={11} color="#fff" solid />}
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label="Description">
            <TextInput style={[styles.input, styles.textarea]} value={description} onChangeText={setDescription}
              placeholder="Who you are, what you do, who it's for…" placeholderTextColor={colors.textLight} multiline />
          </Field>

          <Field label="Area">
            <TextInput style={styles.input} value={area} onChangeText={setArea}
              placeholder="e.g. Lerwick, Burra, Yell" placeholderTextColor={colors.textLight} />
          </Field>

          <Field label="Contact email">
            <TextInput style={styles.input} value={email} onChangeText={setEmail}
              placeholder="hello@yourgroup.org" placeholderTextColor={colors.textLight}
              keyboardType="email-address" autoCapitalize="none" />
          </Field>

          <Field label="Contact phone">
            <TextInput style={styles.input} value={phone} onChangeText={setPhone}
              placeholder="Optional" placeholderTextColor={colors.textLight} keyboardType="phone-pad" />
          </Field>

          <Field label="Website / social link">
            <TextInput style={styles.input} value={website} onChangeText={setWebsite}
              placeholder="https://…" placeholderTextColor={colors.textLight} autoCapitalize="none" />
          </Field>

          <View style={styles.joinModeCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.joinModeTitle}>Approve new members</Text>
              <Text style={styles.joinModeSub}>
                {joinMode === 'approval'
                  ? 'Requests wait for a committee member to approve.'
                  : 'Anyone can join instantly.'}
              </Text>
            </View>
            <Switch
              value={joinMode === 'approval'}
              onValueChange={v => setJoinMode(v ? 'approval' : 'open')}
              trackColor={{ true: S.color }}
            />
          </View>

          <View style={styles.joinModeCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.joinModeTitle}>Member directory</Text>
              <Text style={styles.joinModeSub}>
                {directoryEnabled
                  ? 'Members can see a list of fellow members (names only, no contact details).'
                  : 'Off — members can\'t see who else has joined. Recommended for youth/sensitive groups.'}
              </Text>
            </View>
            <Switch
              value={directoryEnabled}
              onValueChange={setDirectoryEnabled}
              trackColor={{ true: S.color }}
            />
          </View>

          <View style={styles.joinModeCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.joinModeTitle}>Registered charity / CASC</Text>
              <Text style={styles.joinModeSub}>
                {isCharity
                  ? 'Donations can offer Gift Aid (+25%). Add your charity/CASC number.'
                  : 'Turn on if you\'re a registered charity or CASC — enables Gift Aid on donations.'}
              </Text>
            </View>
            <Switch value={isCharity} onValueChange={setIsCharity} trackColor={{ true: S.color }} />
          </View>
          {isCharity ? (
            <Field label="Charity / CASC number">
              <TextInput style={styles.input} value={charityNumber} onChangeText={setCharityNumber}
                placeholder="e.g. SC012345" placeholderTextColor={colors.textLight} autoCapitalize="characters" />
            </Field>
          ) : null}

          <Button label={id ? 'Save changes' : 'Create hub'} icon="check" color={S.color} fullWidth
            loading={saving} disabled={saving} onPress={save} style={styles.saveBtn} />
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  content: { padding: spacing.md },
  field: { marginBottom: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 },

  logoBanner: { height: 110, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  logoPick: { alignItems: 'center', justifyContent: 'center' },
  logoImg: { width: 76, height: 76, borderRadius: 20, borderWidth: 3, borderColor: '#fff' },
  logoPlaceholder: { backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  logoHint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 8, textAlign: 'center' },
  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary,
  },
  textarea: { minHeight: 96, textAlignVertical: 'top' },

  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999,
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
  },
  typeText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },

  paletteRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  swatch: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  swatchActive: { borderWidth: 3, borderColor: 'rgba(0,0,0,0.15)' },

  joinModeCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginTop: spacing.xs,
  },
  joinModeTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  joinModeSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },

  note: { fontSize: fontSize.xs, color: colors.textLight, marginTop: spacing.md, fontStyle: 'italic' },
  saveBtn: { marginTop: spacing.lg },
});
