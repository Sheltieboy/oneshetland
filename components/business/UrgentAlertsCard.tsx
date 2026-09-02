"use client";
/**
 * UrgentAlertsCard — request access, compose and manage urgent broadcasts.
 *
 * This lived inside the business dashboard, which meant Business Home rendered
 * a whole manager: an explainer, an access-request panel, a composer, a
 * scheduler and the active-alert list. Home is status and navigation; the
 * manager belongs on the alerts screen, which is where this now is.
 *
 * Nothing about approval, policy acceptance or sending changed — only where the
 * component lives and the fact that it now feeds itself.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Switch, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import { Sheet } from '@/components/ui/Sheet';
import {
  fetchMyAlertAccess, fetchMyBusinessAlerts, fetchScheduledAlerts,
  requestAlertAccess, sendAlert, cancelAlert, acceptAlertPolicy,
  type AlertAccess, type PartnerAlert, type AlertType,
} from '@/lib/alerts-api';

const ALERT_COLORS = {
  emergency:  { color: '#FF3B30', bg: '#FFF2F1', label: 'Emergency',  icon: 'exclamation-triangle' },
  disruption: { color: '#FF9500', bg: '#FFF8EC', label: 'Disruption', icon: 'exclamation-circle'   },
  info:       { color: '#0A84FF', bg: '#EEF5FF', label: 'Info',       icon: 'info-circle'           },
} as const;

const DURATION_OPTIONS: { label: string; hours: number | null }[] = [
  { label: '1h',      hours: 1    },
  { label: '2h',      hours: 2    },
  { label: '4h',      hours: 4    },
  { label: '8h',      hours: 8    },
  { label: '24h',     hours: 24   },
  { label: 'No expiry', hours: null },
];

export function UrgentAlertsCard({ business }: { business: { id: string; name: string } }) {
  /* Self-contained. It used to take twelve props from the business dashboard,
     which is why it could only ever live there — and why Business Home ended up
     hosting a whole manager. It owns its compose state and fetches its own
     access and alerts, so the screen that shows it only has to know which
     business it is for. */
  const [access,          setAccess]          = useState<AlertAccess | null>(null);
  const [activeAlerts,    setActiveAlerts]    = useState<PartnerAlert[]>([]);
  const [scheduledAlerts, setScheduledAlerts] = useState<PartnerAlert[]>([]);
  const [alertMessage,    setAlertMessage]    = useState('');
  const [alertType,       setAlertType]       = useState<AlertType>('info');
  const [alertBusy,       setAlertBusy]       = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [sendLater,       setSendLater]       = useState(false);
  const [scheduledFor,    setScheduledFor]    = useState<Date | null>(null);
  const [alertDuration,   setAlertDuration]   = useState<number | null>(2);
  const [showDatePicker,  setShowDatePicker]  = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customPickerDate, setCustomPickerDate] = useState<Date>(new Date());

  const reload = useCallback(async () => {
    const [acc, act, sched] = await Promise.all([
      fetchMyAlertAccess(business.id).catch(() => null),
      fetchMyBusinessAlerts(business.id).catch(() => [] as PartnerAlert[]),
      fetchScheduledAlerts(business.id).catch(() => [] as PartnerAlert[]),
    ]);
    setAccess(acc as AlertAccess | null);
    setActiveAlerts((act as PartnerAlert[]).filter(a => a.is_active));
    setScheduledAlerts(sched as PartnerAlert[]);
  }, [business.id]);
  useEffect(() => { void reload(); }, [reload]);

  const onMessageChange = setAlertMessage;
  const onTypeChange = setAlertType;
  const onDurationChange = setAlertDuration;
  const onPickTime = () => setShowDatePicker(true);
  const onToggleSendLater = () => {
    setSendLater(v => !v);
    if (!sendLater) setScheduledFor(null);
  };
  const onRequestAccess = async () => {
    setRequestingAccess(true);
    try { await requestAlertAccess(business.id); await reload(); }
    catch (e: any) { alert({ title: 'Error', message: e?.message ?? 'Could not send request' }); }
    finally { setRequestingAccess(false); }
  };
  const onSendAlert = async () => {
    if (!alertMessage.trim()) return;
    if (sendLater && !scheduledFor) {
      alert({ title: 'Pick a time', message: 'Please choose when you want this alert to go out.' });
      return;
    }
    setAlertBusy(true);
    try {
      const expiresAt = alertDuration ? new Date(Date.now() + alertDuration * 3600 * 1000) : null;
      await sendAlert({
        businessId: business.id, businessName: business.name,
        message: alertMessage.trim(), type: alertType,
        scheduledFor: sendLater ? scheduledFor : null, expiresAt,
      });
      setAlertMessage(''); setSendLater(false); setScheduledFor(null);
      await reload();
      if (sendLater && scheduledFor) {
        const when = scheduledFor.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
        alert({ title: 'Alert scheduled', message: `Your alert will go live on ${when}.` });
      } else {
        alert({ title: 'Alert sent', message: 'Your alert is now live across OneShetland.' });
      }
    } catch (e: any) { alert({ title: 'Error', message: e?.message ?? 'Could not send alert' }); }
    finally { setAlertBusy(false); }
  };
  const onCancelAlert = async (id: string) => {
    try { await cancelAlert(id); await reload(); } catch {}
  };
  const onAcceptPolicy = async () => {
    try { await acceptAlertPolicy(business.id); await reload(); }
    catch (e) { alert({ title: 'Could not enable alerts', message: e instanceof Error ? e.message : 'Please try again.' }); }
  };

  const router = useRouter();
  const { alert } = useAlert();
  const ALERT_RED = '#FF3B30';
  /* Collapsed on Home. Everything below — the explainer, the access request,
     the composer — is the manager, and Home is not the manager. It opens on a
     tap rather than moving anywhere, so nothing is lost and nothing had to be
     rebuilt on the alerts screen. An alert already running still shows. */
  const [open, setOpen] = useState(true);

  return (
    <View style={[alertStyles.card, activeAlerts.length > 0 && alertStyles.cardActive]}>
      {/* Header */}
      <View style={alertStyles.header}>
        <View style={[alertStyles.iconWrap, { backgroundColor: ALERT_RED + '14' }]}>
          <FontAwesome5 name="broadcast-tower" size={14} color={ALERT_RED} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={alertStyles.title}>Urgent Alerts</Text>
          <Text style={alertStyles.sub}>
            {access?.status === 'active'
              ? activeAlerts.length > 0 ? `${activeAlerts.length} alert live` : 'Send real-time alerts to all users'
              : 'Broadcast urgent messages across OneShetland'}
          </Text>
        </View>
        {activeAlerts.length > 0 && (
          <View style={alertStyles.liveBadge}>
            <View style={alertStyles.liveDot} />
            <Text style={alertStyles.liveText}>LIVE</Text>
          </View>
        )}
      </View>

      {/* One tap opens the manager's worth of controls; the header alone is
          what Home needs to say. */}
      {!open && (
        <TouchableOpacity onPress={() => setOpen(true)} hitSlop={8} activeOpacity={0.7}>
          <Text style={[alertStyles.openLink, { color: ALERT_RED }]}>
            {activeAlerts.length > 0 ? 'Manage alerts' : 'Send an urgent alert'}
          </Text>
        </TouchableOpacity>
      )}

      {open && (<>

      {/* State: no access request yet */}
      {!access && (
        <View style={alertStyles.stateBox}>
          <Text style={alertStyles.stateDesc}>
            Instantly push urgent messages — ferry updates, event changes, road closures — to every OneShetland user. Requires approval from OneShetland.
          </Text>
          <TouchableOpacity
            style={[alertStyles.requestBtn, requestingAccess && { opacity: 0.6 }]}
            onPress={onRequestAccess}
            disabled={requestingAccess}
            activeOpacity={0.85}
          >
            {requestingAccess
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={alertStyles.requestBtnText}>Request access</Text>
            }
          </TouchableOpacity>
        </View>
      )}

      {/* State: pending approval */}
      {access?.status === 'requested' && (
        <View style={[alertStyles.stateBox, { backgroundColor: '#FFF8EC', borderColor: '#FF9500' + '30' }]}>
          <FontAwesome5 name="clock" size={18} color="#FF9500" />
          <Text style={[alertStyles.stateDesc, { textAlign: 'center' }]}>
            Your request is with OneShetland for review. You'll be notified once approved.
          </Text>
        </View>
      )}

      {/* State: approved — one gate left, and it isn't a payment.
          Accepting the usage policy is free, so this stays in-app. */}
      {access?.status === 'approved' && (
        <View style={[alertStyles.stateBox, { backgroundColor: '#F0FBF3', borderColor: '#34C759' + '40' }]}>
          <FontAwesome5 name="check-circle" size={18} color="#34C759" />
          <Text style={[alertStyles.stateTitle, { textAlign: 'center' }]}>Approved</Text>
          <Text style={[alertStyles.stateDesc, { textAlign: 'center' }]}>
            Alerts reach every OneShetland user straight away, and urgent ones arrive outside normal
            hours. Send one only when it changes what somebody does today — cancelled transport, a
            road closure, a venue change, severe weather.{'\n\n'}
            Never for offers, opening hours or minor service changes. If a broken coffee machine goes
            out as an alert, the next real one gets ignored. Misuse withdraws access.
          </Text>
          <TouchableOpacity style={alertStyles.activateBtn} onPress={onAcceptPolicy}>
            <Text style={alertStyles.activateBtnText}>I understand — enable alerts</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* State: active — compose + active alerts */}
      {access?.status === 'active' && (
        <View style={alertStyles.activeArea}>
          {/* Active alerts */}
          {activeAlerts.map(a => {
            const meta = ALERT_COLORS[a.type];
            return (
              <View key={a.id} style={[alertStyles.activeAlert, { backgroundColor: meta.bg, borderColor: meta.color + '40' }]}>
                <View style={[alertStyles.alertColorBar, { backgroundColor: meta.color }]} />
                <FontAwesome5 name={meta.icon} size={12} color={meta.color} solid style={{ marginRight: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[alertStyles.alertTypeBadge, { color: meta.color }]}>{meta.label.toUpperCase()}</Text>
                  <Text style={alertStyles.alertMsg} numberOfLines={2}>{a.message}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => alert({
                    title: 'Cancel alert?',
                    message: 'It will be removed from the app immediately.',
                    actions: [
                      { label: 'Keep', style: 'cancel' },
                      { label: 'Cancel alert', style: 'destructive', onPress: () => onCancelAlert(a.id) },
                    ],
                  })}
                  hitSlop={10}
                >
                  <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            );
          })}

          {/* View all link */}
          <TouchableOpacity
            style={alertStyles.viewAllRow}
            onPress={() => router.push({ pathname: '/business-alerts', params: { businessId: business.id, businessName: business.name } } as any)}
          >
            <Text style={alertStyles.viewAllText}>View all alerts & history</Text>
            <FontAwesome5 name="chevron-right" size={10} color={colors.accent} />
          </TouchableOpacity>

          {/* Compose */}
          <Text style={alertStyles.composeLabel}>Send a new alert</Text>

          {/* Type selector */}
          <View style={alertStyles.typeRow}>
            {(Object.entries(ALERT_COLORS) as [AlertType, typeof ALERT_COLORS[AlertType]][]).map(([key, meta]) => (
              <TouchableOpacity
                key={key}
                style={[
                  alertStyles.typeChip,
                  alertType === key && { backgroundColor: meta.color, borderColor: meta.color },
                ]}
                onPress={() => onTypeChange(key)}
                activeOpacity={0.8}
              >
                <FontAwesome5 name={meta.icon} size={9} color={alertType === key ? '#fff' : meta.color} solid />
                <Text style={[alertStyles.typeChipText, { color: alertType === key ? '#fff' : meta.color }]}>
                  {meta.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Scheduled alerts */}
          {scheduledAlerts.length > 0 && (
            <View style={alertStyles.scheduledSection}>
              <Text style={alertStyles.composeLabel}>SCHEDULED</Text>
              {scheduledAlerts.map(a => {
                const meta = ALERT_COLORS[a.type];
                const when = new Date(a.starts_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
                return (
                  <View key={a.id} style={[alertStyles.activeAlert, { backgroundColor: meta.bg, borderColor: meta.color + '40' }]}>
                    <View style={[alertStyles.alertColorBar, { backgroundColor: meta.color }]} />
                    <FontAwesome5 name="clock" size={12} color={meta.color} style={{ marginRight: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[alertStyles.alertTypeBadge, { color: meta.color }]}>SCHEDULED · {when}</Text>
                      <Text style={alertStyles.alertMsg} numberOfLines={2}>{a.message}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => alert({
                        title: 'Cancel scheduled alert?',
                        message: 'It will be deleted and never sent.',
                        actions: [
                          { label: 'Keep', style: 'cancel' },
                          { label: 'Delete', style: 'destructive', onPress: () => onCancelAlert(a.id) },
                        ],
                      })}
                      hitSlop={10}
                    >
                      <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          )}

          {/* Message input */}
          <TextInput
            style={alertStyles.messageInput}
            placeholder="What do people need to know right now?"
            placeholderTextColor={colors.textLight}
            value={alertMessage}
            onChangeText={onMessageChange}
            multiline
            maxLength={200}
          />
          <Text style={alertStyles.charCount}>{alertMessage.length}/200</Text>

          {/* Duration selector */}
          <View style={{ gap: 6 }}>
            <Text style={alertStyles.composeLabel}>LASTS FOR</Text>
            <View style={alertStyles.durationRow}>
              {DURATION_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={String(opt.hours)}
                  style={[alertStyles.durationChip, alertDuration === opt.hours && alertStyles.durationChipActive]}
                  onPress={() => onDurationChange(opt.hours)}
                  activeOpacity={0.7}
                >
                  <Text style={[alertStyles.durationChipText, alertDuration === opt.hours && alertStyles.durationChipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Send Later toggle */}
          <TouchableOpacity style={alertStyles.sendLaterRow} onPress={onToggleSendLater} activeOpacity={0.7}>
            <View style={{ flex: 1 }}>
              <Text style={alertStyles.sendLaterLabel}>Send later</Text>
              {sendLater && scheduledFor && (
                <TouchableOpacity onPress={onPickTime} hitSlop={6}>
                  <Text style={alertStyles.sendLaterTime}>
                    {scheduledFor.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · change
                  </Text>
                </TouchableOpacity>
              )}
              {sendLater && !scheduledFor && (
                <TouchableOpacity onPress={onPickTime} hitSlop={6}>
                  <Text style={[alertStyles.sendLaterTime, { color: colors.accent }]}>Tap to pick a time →</Text>
                </TouchableOpacity>
              )}
            </View>
            <Switch
              value={sendLater}
              onValueChange={onToggleSendLater}
              trackColor={{ true: colors.accent, false: colors.border }}
              thumbColor="#fff"
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              alertStyles.sendBtn,
              { backgroundColor: sendLater ? colors.navy : ALERT_COLORS[alertType].color },
              (!alertMessage.trim() || alertBusy || (sendLater && !scheduledFor)) && { opacity: 0.5 },
            ]}
            onPress={onSendAlert}
            disabled={!alertMessage.trim() || alertBusy || (sendLater && !scheduledFor)}
            activeOpacity={0.85}
          >
            {alertBusy
              ? <ActivityIndicator size="small" color="#fff" />
              : <>
                  <FontAwesome5 name={sendLater ? 'clock' : 'broadcast-tower'} size={12} color="#fff" solid />
                  <Text style={alertStyles.sendBtnText}>{sendLater ? 'Schedule alert' : 'Broadcast alert'}</Text>
                </>
            }
          </TouchableOpacity>
        </View>
      )}
      </>)}
    </View>
  );
          {showDatePicker && (
            <Sheet
              visible={showDatePicker}
              onClose={() => { setShowDatePicker(false); setShowCustomPicker(false); }}
            >
                    <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginBottom: spacing.md }}>
                      {showCustomPicker ? 'Pick a time' : 'Schedule alert'}
                    </Text>

                    {!showCustomPicker ? (
                      <>
                        {[
                          { label: 'In 1 hour',     getDate: () => new Date(Date.now() + 3600000) },
                          { label: 'In 2 hours',    getDate: () => new Date(Date.now() + 7200000) },
                          { label: 'Tomorrow 9am',  getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
                          { label: 'Tomorrow noon', getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d; } },
                        ].map((p) => (
                          <TouchableOpacity
                            key={p.label}
                            style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
                            onPress={() => { setScheduledFor(p.getDate()); setShowDatePicker(false); }}
                          >
                            <Text style={{ fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' }}>{p.label}</Text>
                            <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 }}>
                              {p.getDate().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                            </Text>
                          </TouchableOpacity>
                        ))}

                        <TouchableOpacity
                          style={{ paddingVertical: 14 }}
                          onPress={() => {
                            const d = new Date();
                            d.setDate(d.getDate() + 1);
                            d.setHours(9, 0, 0, 0);
                            setCustomPickerDate(d);
                            setShowCustomPicker(true);
                          }}
                        >
                          <Text style={{ fontSize: fontSize.sm, color: colors.accent, fontWeight: '700' }}>Pick a custom time →</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <DateTimePicker
                          value={customPickerDate}
                          mode="datetime"
                          display="spinner"
                          minimumDate={new Date()}
                          onChange={(_e, date) => { if (date) setCustomPickerDate(date); }}
                          style={{ height: 180 }}
                        />
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: spacing.md }}>
                          <TouchableOpacity
                            style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}
                            onPress={() => setShowCustomPicker(false)}
                          >
                            <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted }}>Back</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{ flex: 2, paddingVertical: 12, borderRadius: radius.md, backgroundColor: colors.navy, alignItems: 'center' }}
                            onPress={() => { setScheduledFor(customPickerDate); setShowDatePicker(false); setShowCustomPicker(false); }}
                          >
                            <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#fff' }}>
                              Confirm — {customPickerDate.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </>
                    )}
            </Sheet>
          )}
}

const alertStyles = StyleSheet.create({
  openLink:  { fontSize: 14, fontWeight: '800', marginTop: 10 },
  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 14,
    marginBottom: 0,
  },
  cardActive: {
    borderColor: '#FF3B30' + '40',
    borderWidth: 1.5,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  iconWrap: {
    width: 38, height: 38, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  sub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#FF3B30' + '12',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full,
  },
  liveDot:  { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF3B30' },
  liveText: { fontSize: 9, fontWeight: '900', letterSpacing: 1, color: '#FF3B30' },

  stateBox: {
    backgroundColor: colors.screenBackground,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 12, alignItems: 'center',
  },
  stateTitle: {
    fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary,
  },
  stateDesc: {
    fontSize: fontSize.sm, color: colors.textSecondary,
    lineHeight: 19, textAlign: 'left',
  },
  requestBtn: {
    backgroundColor: colors.navy,
    borderRadius: radius.md, paddingVertical: 11, paddingHorizontal: 20,
    alignSelf: 'stretch', alignItems: 'center',
  },
  requestBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  activateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: '#34C759', borderRadius: radius.md,
    paddingVertical: 11, paddingHorizontal: 20, alignSelf: 'stretch', justifyContent: 'center',
  },
  activateBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  activeArea: { gap: 10 },
  activeAlert: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: radius.md, borderWidth: 1,
    paddingVertical: 10, paddingRight: 12, overflow: 'hidden',
  },
  alertColorBar:  { width: 4, alignSelf: 'stretch', minHeight: 36 },
  alertTypeBadge: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  alertMsg:       { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600', marginTop: 1 },

  composeLabel: {
    fontSize: fontSize.xs, fontWeight: '900', color: colors.textMuted,
    letterSpacing: 0.5, marginTop: 4,
  },
  typeRow: { flexDirection: 'row', gap: 8 },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
  },
  typeChipText: { fontSize: 11, fontWeight: '800' },

  messageInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, fontSize: fontSize.sm, color: colors.textPrimary,
    minHeight: 80, textAlignVertical: 'top',
    backgroundColor: colors.screenBackground,
  },
  charCount: { fontSize: 10, color: colors.textLight, textAlign: 'right', marginTop: -6 },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, borderRadius: radius.md,
  },
  sendBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

  scheduledSection: { gap: 8 },

  viewAllRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
    paddingVertical: 4,
  },
  viewAllText: { fontSize: fontSize.xs, color: colors.accent, fontWeight: '700' },

  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  durationChip: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
  },
  durationChipActive: { borderColor: colors.navy, backgroundColor: colors.navy },
  durationChipText:   { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  durationChipTextActive: { color: '#fff' },

  sendLaterRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: colors.screenBackground,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    gap: 12,
  },
  sendLaterLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  sendLaterTime:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
