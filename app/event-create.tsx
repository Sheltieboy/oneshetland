/**
 * event-create.tsx — Create or edit an event
 * Params: businessId (required), eventId (optional — edit mode)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Switch, Image, Modal, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';

const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? '';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchEvent,
  createEvent, updateEvent,
  uploadEventImage,
  upsertTicketType, deleteTicketType,
  EVENT_CATEGORIES, AGE_RESTRICTIONS,
  type EventUpsertInput, type EventTicketType, type HubEventVisibility,
} from '@/lib/events-api';
import { fetchHub, createHubNotice } from '@/lib/hubs-api';

const S = SECTIONS.events;

const CATEGORY_OPTIONS = ['', ...EVENT_CATEGORIES];

export default function EventCreateScreen() {
  const { businessId, hubId, eventId } = useLocalSearchParams<{ businessId?: string; hubId?: string; eventId?: string }>();
  const router  = useRouter();
  const { profile } = useAuth();

  const isEdit = !!eventId;
  const isHub  = !!hubId;

  // Hub-event reach + verification (drives the visibility picker + approval note)
  const [hubVisibility, setHubVisibility] = useState<HubEventVisibility>('hub');
  const [hubVerified,   setHubVerified]   = useState(false);
  const [hubName,       setHubName]       = useState('');
  const [postNotice,    setPostNotice]    = useState(true);

  const [loading,  setLoading]  = useState(isEdit);
  const [saving,   setSaving]   = useState(false);

  // Basic info
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [category,    setCategory]    = useState('');
  const [venue,       setVenue]       = useState('');
  const [address,     setAddress]     = useState('');
  const [lat,         setLat]         = useState<number | null>(null);
  const [lng,         setLng]         = useState<number | null>(null);
  const [placeId,     setPlaceId]     = useState<string | null>(null);
  const [ageRestr,    setAgeRestr]    = useState('All ages');

  // Date/time
  const [startsAt,    setStartsAt]    = useState<Date>(new Date(Date.now() + 7 * 86400_000));
  const [endsAt,      setEndsAt]      = useState<Date | null>(null);
  const [doorsAt,     setDoorsAt]     = useState<Date | null>(null);
  const [showPicker,  setShowPicker]  = useState<null | 'starts' | 'ends' | 'doors'>(null);
  const [pickerDraft, setPickerDraft] = useState<Date>(new Date());

  // Media
  const [coverUrl,    setCoverUrl]    = useState<string | null>(null);
  const [coverLocal,  setCoverLocal]  = useState<string | null>(null);
  const [uploadingImg,setUploadingImg]= useState(false);

  // Tickets
  const [hasTickets,  setHasTickets]  = useState(false);
  const [ticketTypes, setTicketTypes] = useState<(Partial<EventTicketType> & { _local?: boolean })[]>([]);

  // Misc
  const [refundPolicy, setRefundPolicy] = useState('');
  const [contactInfo,  setContactInfo]  = useState('');
  const [eventNotes,   setEventNotes]   = useState('');

  const load = useCallback(async () => {
    if (!eventId) return;
    const ev = await fetchEvent(eventId);
    if (!ev) { setLoading(false); return; }
    setTitle(ev.title);
    setDescription(ev.description ?? '');
    setCategory(ev.category ?? '');
    setVenue(ev.venue ?? '');
    setAddress(ev.formatted_address ?? '');
    setLat(ev.lat ?? null);
    setLng(ev.lng ?? null);
    setPlaceId(ev.place_id ?? null);
    setStartsAt(new Date(ev.starts_at));
    if (ev.ends_at) setEndsAt(new Date(ev.ends_at));
    if (ev.doors_open_at) setDoorsAt(new Date(ev.doors_open_at));
    setCoverUrl(ev.cover_url);
    if (ev.hub_visibility) setHubVisibility(ev.hub_visibility);
    setHasTickets(ev.has_tickets);
    if (ev.ticket_types) setTicketTypes(ev.ticket_types);
    setAgeRestr(ev.age_restriction ?? 'All ages');
    setRefundPolicy(ev.refund_policy ?? '');
    setContactInfo(ev.contact_info ?? '');
    setEventNotes(ev.event_notes ?? '');
    setLoading(false);
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  // Load the hub (verification + name) when creating/editing a hub event.
  useEffect(() => {
    if (!hubId) return;
    void (async () => {
      const h = await fetchHub(hubId);
      if (h) { setHubVerified(h.is_verified); setHubName(h.name); }
    })();
  }, [hubId]);

  const pickCover = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, aspect: [16, 9],
    });
    if (!res.canceled && res.assets[0]) {
      setCoverLocal(res.assets[0].uri);
    }
  };

  const uploadCover = async (): Promise<string | null> => {
    if (!coverLocal) return coverUrl;
    setUploadingImg(true);
    try {
      // The event-media bucket keys on the signed-in user, so the folder id is
      // irrelevant — works for both business and hub organisers.
      const url = await uploadEventImage(businessId ?? hubId ?? '', coverLocal, 'cover');
      return url;
    } finally {
      setUploadingImg(false);
    }
  };

  const addTicketType = () => {
    setTicketTypes(prev => [...prev, {
      _local: true,
      name: '',
      price_pence: 0,
      quantity_available: null,
      per_order_max: 10,
      is_active: true,
      requires_attendee_details: false,
    }]);
  };

  const handleSave = async (publish = false) => {
    if (!title.trim()) { Alert.alert('Title required'); return; }
    if (!profile) return;
    setSaving(true);
    try {
      const finalCover = await uploadCover();

      const payload: EventUpsertInput = {
        organiser_business_id: isHub ? undefined : businessId,
        organiser_hub_id:      isHub ? hubId : undefined,
        hub_visibility:        isHub ? hubVisibility : undefined,
        title:              title.trim(),
        description:        description.trim() || null,
        category:           category || null,
        status:             publish ? 'published' : 'draft',
        venue:              venue.trim() || null,
        formatted_address:  address.trim() || null,
        lat,
        lng,
        place_id:           placeId,
        starts_at:          startsAt.toISOString(),
        ends_at:            endsAt?.toISOString() ?? null,
        doors_open_at:      doorsAt?.toISOString() ?? null,
        cover_url:          finalCover,
        has_tickets:        hasTickets,
        age_restriction:    ageRestr !== 'All ages' ? ageRestr : null,
        refund_policy:      refundPolicy.trim() || null,
        contact_info:       contactInfo.trim() || null,
        event_notes:        eventNotes.trim() || null,
      };

      let targetId: string;
      if (isEdit) {
        await updateEvent(eventId, payload);
        targetId = eventId;
      } else {
        const ev = await createEvent(profile.id, payload);
        targetId = ev.id;
      }

      // Upsert ticket types
      for (const tt of ticketTypes) {
        if (!tt.name?.trim()) continue;
        await upsertTicketType({
          id:                       tt._local ? undefined : tt.id,
          event_id:                 targetId,
          name:                     tt.name!,
          description:              tt.description ?? null,
          price_pence:              tt.price_pence ?? 0,
          quantity_available:       tt.quantity_available ?? null,
          per_order_max:            tt.per_order_max ?? 10,
          is_active:                tt.is_active ?? true,
          requires_attendee_details:tt.requires_attendee_details ?? false,
          sale_starts_at:           tt.sale_starts_at ?? null,
          sale_ends_at:             tt.sale_ends_at ?? null,
          display_order:            tt.display_order ?? 0,
        } as any);
      }

      // For a freshly-published hub event, optionally announce it as a notice.
      // members → members-only notice; hub/islands → public notice (the home
      // feed only surfaces it islands-wide once the event is calendar-approved).
      if (isHub && hubId && publish && !isEdit && postNotice) {
        try {
          await createHubNotice(hubId, {
            title:      `New event: ${title.trim()}`,
            body:       description.trim() || null,
            image_url:  finalCover,
            visibility: hubVisibility === 'members' ? 'members' : 'public',
            event_id:   targetId,
          });
        } catch { /* notice is best-effort */ }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace({ pathname: '/event-manage', params: { id: targetId } });
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Please try again');
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

  const previewImg = coverLocal ?? coverUrl;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isEdit ? 'Edit Event' : 'New Event'}</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* Cover image */}
        <TouchableOpacity style={styles.coverPicker} onPress={pickCover} activeOpacity={0.85}>
          {previewImg ? (
            <Image source={{ uri: previewImg }} style={styles.coverPreview} />
          ) : (
            <View style={styles.coverPlaceholder}>
              <FontAwesome5 name="image" size={28} color={S.color + '80'} />
              <Text style={styles.coverPlaceholderText}>Tap to add cover image</Text>
            </View>
          )}
          {uploadingImg && (
            <View style={styles.coverUploading}>
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </TouchableOpacity>

        {/* Basic info */}
        <View style={styles.section}>
          <Field label="Event title *">
            <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Shetland Folk Festival" placeholderTextColor={colors.textLight} />
          </Field>
          <Field label="Description">
            <TextInput style={[styles.input, styles.inputMulti]} value={description} onChangeText={setDescription} placeholder="Describe the event..." placeholderTextColor={colors.textLight} multiline numberOfLines={4} />
          </Field>
          <Field label="Category">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
              {CATEGORY_OPTIONS.map(cat => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.optionChip, category === cat && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => setCategory(cat)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.optionChipText, category === cat && { color: '#fff' }]}>
                    {cat || 'None'}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Field>
        </View>

        {/* Hub event reach */}
        {isHub ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Who can see this?</Text>
            {([
              { v: 'members' as const, icon: 'user-friends', title: 'Members only',  sub: 'Just your members — posts a notice to them.' },
              { v: 'hub'     as const, icon: 'store',        title: 'On your hub page', sub: 'Public on your hub’s page, not the main calendar.' },
              { v: 'islands' as const, icon: 'globe-europe', title: 'Islands-wide',   sub: 'Also on the main What’s On calendar.' },
            ]).map(opt => {
              const on = hubVisibility === opt.v;
              return (
                <TouchableOpacity
                  key={opt.v}
                  style={[styles.reachRow, on && { borderColor: S.color, backgroundColor: S.color + '0D' }]}
                  onPress={() => setHubVisibility(opt.v)}
                  activeOpacity={0.85}
                >
                  <View style={[styles.reachIcon, { backgroundColor: on ? S.color : S.color + '1A' }]}>
                    <FontAwesome5 name={opt.icon as any} size={14} color={on ? '#fff' : S.color} solid />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reachTitle}>{opt.title}</Text>
                    <Text style={styles.reachSub}>{opt.sub}</Text>
                  </View>
                  <FontAwesome5 name={on ? 'check-circle' : 'circle'} size={18} color={on ? S.color : colors.border} solid={on} />
                </TouchableOpacity>
              );
            })}
            {hubVisibility === 'islands' && !hubVerified ? (
              <Text style={styles.reachNote}>
                <FontAwesome5 name="info-circle" size={11} color={colors.textMuted} solid />{'  '}
                Your hub isn’t verified yet, so islands-wide events need a quick OK from the OneShetland team before they appear on the main calendar. It’ll show on your hub page in the meantime.
              </Text>
            ) : null}
            <View style={styles.noticeToggleRow}>
              <Text style={styles.reachTitle}>Announce with a notice</Text>
              <Switch
                value={postNotice}
                onValueChange={setPostNotice}
                trackColor={{ true: S.color }}
              />
            </View>
          </View>
        ) : null}

        {/* Location */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={{ gap: 4, marginBottom: 10 }}>
            <Text style={styles.fieldLabel}>Venue / address</Text>
            {/* GooglePlacesAutocomplete needs keyboardShouldPersistTaps on the
                parent ScrollView — handled by the scrollView prop below */}
            <GooglePlacesAutocomplete
              placeholder={venue || address || 'Search for a venue or address…'}
              minLength={2}
              fetchDetails
              onPress={(data, details = null) => {
                // Extract structured name vs address components
                const name   = details?.name ?? data.structured_formatting?.main_text ?? '';
                const fmtAddr = details?.formatted_address ?? data.description;
                const loc    = details?.geometry?.location;
                const pid    = data.place_id ?? null;

                setVenue(name);
                setAddress(fmtAddr);
                setLat(loc?.lat ?? null);
                setLng(loc?.lng ?? null);
                setPlaceId(pid);
              }}
              query={{
                key:        GOOGLE_KEY,
                language:   'en',
                components: 'country:gb',
                location:   '60.3,-1.2',  // Lerwick — biases results toward Shetland
                radius:     '80000',
              }}
              textInputProps={{
                placeholderTextColor: colors.textLight,
                // Show the current saved value as the initial text
                defaultValue: venue || address,
              }}
              styles={{
                container:   { flex: 0, zIndex: 10 },
                textInput:   styles.input,
                listView: {
                  backgroundColor: '#fff',
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  marginTop: 4,
                  zIndex: 10,
                },
                row:           { paddingHorizontal: 12, paddingVertical: 10 },
                description:   { fontSize: fontSize.sm, color: colors.textPrimary },
                poweredContainer: { display: 'none' },
              }}
              enablePoweredByContainer={false}
              debounce={300}
              keepResultsAfterBlur
            />
            {/* Confirmation chips — shown once a place is picked */}
            {(venue || address) && (
              <View style={styles.placeConfirm}>
                {venue ? (
                  <View style={styles.placeChip}>
                    <FontAwesome5 name="map-marker-alt" size={10} color={S.color} />
                    <Text style={styles.placeChipText} numberOfLines={1}>{venue}</Text>
                  </View>
                ) : null}
                {address && address !== venue ? (
                  <Text style={styles.placeAddr} numberOfLines={2}>{address}</Text>
                ) : null}
                <TouchableOpacity
                  onPress={() => { setVenue(''); setAddress(''); setLat(null); setLng(null); setPlaceId(null); }}
                  hitSlop={8}
                >
                  <Text style={styles.placeClear}>Clear</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>

        {/* Date & time */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Date &amp; time</Text>
          <DateButton label="Starts" date={startsAt} onPress={() => { setPickerDraft(startsAt); setShowPicker('starts'); }} />
          <DateButton label="Ends (optional)" date={endsAt} onPress={() => { setPickerDraft(endsAt ?? startsAt); setShowPicker('ends'); }} />
          <DateButton label="Doors open (optional)" date={doorsAt} onPress={() => { setPickerDraft(doorsAt ?? startsAt); setShowPicker('doors'); }} />
        </View>

        {/* Age restriction */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Age restriction</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
            {AGE_RESTRICTIONS.map(a => (
              <TouchableOpacity
                key={a}
                style={[styles.optionChip, ageRestr === a && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => setAgeRestr(a)}
                activeOpacity={0.8}
              >
                <Text style={[styles.optionChipText, ageRestr === a && { color: '#fff' }]}>{a}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Tickets */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Tickets</Text>
            <Switch value={hasTickets} onValueChange={setHasTickets} trackColor={{ true: S.color }} />
          </View>
          {hasTickets && (
            <>
              {ticketTypes.map((tt, i) => (
                <View key={i} style={styles.ticketTypeCard}>
                  <TextInput
                    style={styles.input}
                    value={tt.name ?? ''}
                    onChangeText={v => setTicketTypes(prev => { const n = [...prev]; n[i] = { ...n[i], name: v }; return n; })}
                    placeholder="Ticket name (e.g. General, VIP)"
                    placeholderTextColor={colors.textLight}
                  />
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Price (£)</Text>
                      <TextInput
                        style={styles.input}
                        value={tt.price_pence ? String(tt.price_pence / 100) : '0'}
                        onChangeText={v => {
                          const p = Math.round(parseFloat(v || '0') * 100);
                          setTicketTypes(prev => { const n = [...prev]; n[i] = { ...n[i], price_pence: p }; return n; });
                        }}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        placeholderTextColor={colors.textLight}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Quantity (blank = unlimited)</Text>
                      <TextInput
                        style={styles.input}
                        value={tt.quantity_available != null ? String(tt.quantity_available) : ''}
                        onChangeText={v => {
                          const q = v ? parseInt(v, 10) : null;
                          setTicketTypes(prev => { const n = [...prev]; n[i] = { ...n[i], quantity_available: q }; return n; });
                        }}
                        keyboardType="number-pad"
                        placeholder="Unlimited"
                        placeholderTextColor={colors.textLight}
                      />
                    </View>
                  </View>
                  <TouchableOpacity onPress={() => setTicketTypes(prev => prev.filter((_, j) => j !== i))} style={styles.removeLink}>
                    <Text style={styles.removeLinkText}>Remove</Text>
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={styles.addTypeBtn} onPress={addTicketType} activeOpacity={0.8}>
                <FontAwesome5 name="plus" size={11} color={S.color} />
                <Text style={[styles.addTypeBtnText, { color: S.color }]}>Add ticket type</Text>
              </TouchableOpacity>
              <Field label="Refund policy">
                <TextInput style={styles.input} value={refundPolicy} onChangeText={setRefundPolicy} placeholder="e.g. No refunds within 48 hours" placeholderTextColor={colors.textLight} />
              </Field>
            </>
          )}
        </View>

        {/* Extra info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Extra info</Text>
          <Field label="Contact info">
            <TextInput style={styles.input} value={contactInfo} onChangeText={setContactInfo} placeholder="Email or phone" placeholderTextColor={colors.textLight} />
          </Field>
          <Field label="Event notes">
            <TextInput style={[styles.input, styles.inputMulti]} value={eventNotes} onChangeText={setEventNotes} placeholder="Additional notes for attendees..." placeholderTextColor={colors.textLight} multiline numberOfLines={3} />
          </Field>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.draftBtn, saving && { opacity: 0.6 }]}
            onPress={() => handleSave(false)}
            disabled={saving}
            activeOpacity={0.85}
          >
            {saving ? <ActivityIndicator color={S.color} size="small" /> : <Text style={[styles.draftBtnText, { color: S.color }]}>Save as draft</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.publishBtn, { backgroundColor: S.color }, saving && { opacity: 0.6 }]}
            onPress={() => handleSave(true)}
            disabled={saving}
            activeOpacity={0.85}
          >
            {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.publishBtnText}>{isEdit ? 'Save & publish' : 'Publish event'}</Text>}
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Date / time picker modal */}
      <Modal
        visible={showPicker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPicker(null)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          activeOpacity={1}
          onPress={() => setShowPicker(null)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.pickerCard} onPress={() => {}}>
            {/* Header */}
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>
                {showPicker === 'starts' ? 'Start date & time'
                  : showPicker === 'ends' ? 'End date & time'
                  : 'Doors open'}
              </Text>
              <TouchableOpacity onPress={() => setShowPicker(null)} hitSlop={12}>
                <FontAwesome5 name="times" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Spinner — shows both date and time wheels */}
            <DateTimePicker
              value={pickerDraft}
              mode="datetime"
              display="spinner"
              themeVariant="light"
              textColor={colors.textPrimary}
              onChange={(_, d) => { if (d) setPickerDraft(d); }}
              style={{ width: '100%' }}
            />

            {/* Action buttons */}
            <View style={styles.pickerActions}>
              <TouchableOpacity
                style={styles.pickerCancel}
                onPress={() => setShowPicker(null)}
              >
                <Text style={styles.pickerCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pickerConfirm, { backgroundColor: S.color }]}
                onPress={() => {
                  if (showPicker === 'starts') setStartsAt(pickerDraft);
                  else if (showPicker === 'ends') setEndsAt(pickerDraft);
                  else if (showPicker === 'doors') setDoorsAt(pickerDraft);
                  setShowPicker(null);
                }}
              >
                <Text style={styles.pickerConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4, marginBottom: 10 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function DateButton({ label, date, onPress }: { label: string; date: Date | null; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.dateBtn} onPress={onPress} activeOpacity={0.8}>
      <FontAwesome5 name="calendar" size={12} color={S.color} />
      <Text style={styles.dateBtnLabel}>{label}</Text>
      <Text style={[styles.dateBtnValue, { color: date ? colors.textPrimary : colors.textLight }]}>
        {date
          ? date.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'Not set'}
      </Text>
      <FontAwesome5 name="chevron-right" size={10} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Date picker modal
  pickerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  pickerCard: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 34,
  },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 4,
  },
  pickerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  pickerActions: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: spacing.lg, paddingTop: 8,
  },
  pickerCancel: {
    flex: 1, paddingVertical: 14, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  pickerCancelText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },
  pickerConfirm: {
    flex: 2, paddingVertical: 14, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  pickerConfirmText: { fontSize: fontSize.sm, fontWeight: '800', color: '#fff' },

  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.screenBackground },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  coverPicker: { height: 180, backgroundColor: S.color + '18', position: 'relative' },
  coverPreview:{ width: '100%', height: '100%', resizeMode: 'cover' },
  coverPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  coverPlaceholderText: { fontSize: fontSize.sm, color: S.color + '80', fontWeight: '600' },
  coverUploading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center',
  },

  section:          { padding: spacing.md, paddingBottom: 4 },
  sectionTitle:     { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 10 },
  reachRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, marginBottom: 8,
  },
  reachIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  reachTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  reachSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  reachNote: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 2, marginBottom: 4 },
  noticeToggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  fieldLabel:       { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },

  input: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10 },

  optionChip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff',
  },
  optionChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  dateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border, padding: 12, marginBottom: 8,
  },
  dateBtnLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700', width: 100 },
  dateBtnValue: { flex: 1, fontSize: fontSize.sm, fontWeight: '600' },

  ticketTypeCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8, marginBottom: 10,
    ...shadow.card,
  },
  removeLink:     { alignSelf: 'flex-end' },
  removeLinkText: { fontSize: fontSize.xs, color: colors.error, fontWeight: '700' },
  addTypeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 12, paddingHorizontal: 12, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: S.color + '60', borderStyle: 'dashed',
    justifyContent: 'center', marginBottom: 10,
  },
  addTypeBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  actions: {
    padding: spacing.md, gap: 10,
  },
  draftBtn: {
    paddingVertical: 14, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: S.color + '60', alignItems: 'center',
  },
  draftBtnText:   { fontSize: fontSize.sm, fontWeight: '800' },
  publishBtn:     { paddingVertical: 14, borderRadius: radius.md, alignItems: 'center' },
  publishBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

  placeConfirm: { gap: 4, marginTop: 6, paddingHorizontal: 2 },
  placeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: S.light, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start',
  },
  placeChipText: { fontSize: fontSize.xs, fontWeight: '700', color: S.color, maxWidth: 260 },
  placeAddr:     { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  placeClear:    { fontSize: fontSize.xs, color: colors.error, fontWeight: '700', marginTop: 2 },
});
