/**
 * (admin)/email-centre.tsx
 *
 * Central admin screen for managing all OneShetland emails via Postmark.
 *
 * Four tabs:
 *   Templates — view/edit every email template, toggle on/off, test send
 *   Footer    — global sign-off, signature, promo link, legal line
 *   Log       — delivery log (sent, bounced, failed, skipped)
 *   Settings  — from name, from email, reply-to
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Switch, ActivityIndicator, RefreshControl,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAlert } from '@/components/BrandedAlert';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

type Tab = 'templates' | 'footer' | 'log' | 'settings';

const CATEGORY_LABELS: Record<string, string> = {
  account:    'Account',
  security:   'Security',
  compliance: 'Compliance',
  fetch:      'Fetch',
  shifts:     'Shifts',
  local:      'Local',
  platform:   'Platform',
};

const CATEGORY_COLORS: Record<string, string> = {
  account:    colors.accent,
  security:   '#DC2626',
  compliance: '#7C3AED',
  fetch:      '#E0722A',
  shifts:     '#E8A020',
  local:      '#7C3AED',
  platform:   '#10B981',
};

const STATUS_COLORS: Record<string, string> = {
  sent:      '#10B981',
  delivered: '#059669',
  bounced:   '#DC2626',
  failed:    '#EF4444',
  skipped:   '#9CA3AF',
};

interface EmailTemplate {
  id: string;
  key: string;
  category: string;
  label: string;
  description: string | null;
  enabled: boolean;
  subject: string;
  body_html: string;
  variables: string[];
  postmark_stream: string;
}

interface EmailSettings {
  id: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  footer_sign_off: string | null;
  footer_signature: string | null;
  footer_tagline: string | null;
  footer_promo_text: string | null;
  footer_promo_url: string | null;
  footer_legal: string | null;
}

interface EmailLogEntry {
  id: string;
  template_key: string;
  recipient_email: string;
  subject: string;
  status: string;
  sent_at: string;
  error_message: string | null;
}

export default function EmailCentreScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const [tab, setTab] = useState<Tab>('templates');

  // Templates
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [expandedKey, setExpandedKey]   = useState<string | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState<string | null>(null);

  // Footer / Settings
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Partial<EmailSettings>>({});

  // Log
  const [log, setLog] = useState<EmailLogEntry[]>([]);
  const [loadingLog, setLoadingLog] = useState(true);
  const [logFilter, setLogFilter] = useState<string>('all');
  const [refreshing, setRefreshing] = useState(false);

  // ── Load ────────────────────────────────────────────────────────────────────

  const loadTemplates = useCallback(async () => {
    const { data } = await supabase
      .from('email_templates')
      .select('*')
      .order('category')
      .order('label');
    setTemplates((data ?? []) as EmailTemplate[]);
    setLoadingTemplates(false);
  }, []);

  const loadSettings = useCallback(async () => {
    const { data } = await supabase.from('email_settings').select('*').single();
    setSettings(data as EmailSettings);
    setSettingsDraft(data ?? {});
    setLoadingSettings(false);
  }, []);

  const loadLog = useCallback(async () => {
    let q = supabase
      .from('email_log')
      .select('id, template_key, recipient_email, subject, status, sent_at, error_message')
      .order('sent_at', { ascending: false })
      .limit(100);
    if (logFilter !== 'all') q = q.eq('status', logFilter);
    const { data } = await q;
    setLog((data ?? []) as EmailLogEntry[]);
    setLoadingLog(false);
    setRefreshing(false);
  }, [logFilter]);

  useEffect(() => { loadTemplates(); loadSettings(); }, []);
  useEffect(() => { if (tab === 'log') loadLog(); }, [tab, logFilter]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const toggleTemplate = async (tmpl: EmailTemplate) => {
    Haptics.selectionAsync();
    const newEnabled = !tmpl.enabled;
    setTemplates(prev => prev.map(t => t.id === tmpl.id ? { ...t, enabled: newEnabled } : t));
    try {
      const { error } = await supabase.from('email_templates').update({ enabled: newEnabled, updated_at: new Date().toISOString() }).eq('id', tmpl.id);
      if (error) throw error;
    } catch (e: any) {
      setTemplates(prev => prev.map(t => t.id === tmpl.id ? { ...t, enabled: tmpl.enabled } : t));
      alert({ title: 'Could not update', message: e?.message ?? 'Please try again.' });
    }
  };

  const saveTemplate = async () => {
    if (!editingTemplate) return;
    setSavingTemplate(true);
    try {
      await supabase.from('email_templates').update({
        subject:   editingTemplate.subject,
        body_html: editingTemplate.body_html,
        updated_at: new Date().toISOString(),
      }).eq('id', editingTemplate.id);
      setTemplates(prev => prev.map(t => t.id === editingTemplate.id ? editingTemplate : t));
      setEditingTemplate(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert({ title: 'Saved', message: 'Template updated.' });
    } catch (e: any) {
      alert({ title: 'Error', message: e?.message ?? 'Could not save.' });
    } finally {
      setSavingTemplate(false);
    }
  };

  const sendTestEmail = async (tmpl: EmailTemplate) => {
    const email = testEmail.trim();
    if (!email) {
      alert({ title: 'Email needed', message: 'Enter a test email address above.' });
      return;
    }
    setSendingTest(tmpl.id);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const supabaseUrl  = process.env.EXPO_PUBLIC_SUPABASE_URL  ?? '';
      const supabaseAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
      const token = s?.access_token ?? supabaseAnon;

      const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey':         supabaseAnon,
        },
        body: JSON.stringify({
          template_key:    tmpl.key,
          recipient_email: email,
          variables: Object.fromEntries(
            (tmpl.variables ?? []).map(v => [v, `[${v}]`])
          ),
          metadata: { test: true },
        }),
      });

      const json = await res.json() as { ok?: boolean; error?: string; skipped?: boolean };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.skipped) {
        alert({ title: 'Skipped', message: 'This template is disabled. Enable it first.' });
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert({ title: 'Test sent!', message: `Check ${email} for the email.` });
    } catch (e: any) {
      alert({ title: 'Send failed', message: e?.message ?? 'Try again' });
    } finally {
      setSendingTest(null);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      await supabase.from('email_settings').update({ ...settingsDraft, updated_at: new Date().toISOString() }).eq('id', settings.id);
      setSettings({ ...settings, ...settingsDraft } as EmailSettings);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert({ title: 'Saved', message: 'Email settings updated.' });
    } catch (e: any) {
      alert({ title: 'Error', message: e?.message ?? 'Could not save.' });
    } finally {
      setSavingSettings(false);
    }
  };

  // ── Group templates by category ─────────────────────────────────────────────

  const grouped = templates.reduce<Record<string, EmailTemplate[]>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t);
    return acc;
  }, {});

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Email Centre"
          accent={colors.accent}
          onBack={() => router.back()}
        />
      }
    >
      {/* Tab bar */}
      <View style={styles.tabBar}>
        {(['templates', 'footer', 'log', 'settings'] as Tab[]).map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => { Haptics.selectionAsync(); setTab(t); }}
          >
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── TEMPLATES TAB ── */}
      {tab === 'templates' && (
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
          {/* Test email input — global for all templates */}
          <View style={styles.testEmailCard}>
            <FontAwesome5 name="flask" size={12} color={colors.accent} solid />
            <TextInput
              style={styles.testEmailInput}
              value={testEmail}
              onChangeText={setTestEmail}
              placeholder="Test email address..."
              placeholderTextColor={colors.textLight}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          {loadingTemplates
            ? <LoadingState accent={colors.accent} />
            : Object.entries(CATEGORY_LABELS).map(([cat, catLabel]) => {
                const catTemplates = grouped[cat];
                if (!catTemplates?.length) return null;
                const color = CATEGORY_COLORS[cat] ?? colors.accent;
                return (
                  <View key={cat} style={styles.categoryBlock}>
                    <View style={[styles.categoryHeader, { borderLeftColor: color }]}>
                      <Text style={[styles.categoryLabel, { color }]}>{catLabel}</Text>
                      <Text style={styles.categoryCount}>{catTemplates.length} emails</Text>
                    </View>

                    {catTemplates.map(tmpl => {
                      const isExpanded = expandedKey === tmpl.key;
                      const isEditing  = editingTemplate?.id === tmpl.id;
                      return (
                        <View key={tmpl.key} style={styles.templateCard}>
                          {/* Row */}
                          <TouchableOpacity
                            style={styles.templateRow}
                            onPress={() => { setExpandedKey(isExpanded ? null : tmpl.key); setEditingTemplate(null); }}
                            activeOpacity={0.8}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={styles.templateLabel}>{tmpl.label}</Text>
                              {tmpl.description && (
                                <Text style={styles.templateDesc} numberOfLines={1}>{tmpl.description}</Text>
                              )}
                            </View>
                            <View style={styles.templateRowRight}>
                              <View style={[styles.streamPill, { backgroundColor: tmpl.postmark_stream === 'broadcast' ? '#FEF3C7' : '#EFF6FF' }]}>
                                <Text style={[styles.streamText, { color: tmpl.postmark_stream === 'broadcast' ? '#92400E' : '#1D4ED8' }]}>
                                  {tmpl.postmark_stream === 'broadcast' ? 'Broadcast' : 'Transact.'}
                                </Text>
                              </View>
                              <Switch
                                value={tmpl.enabled}
                                onValueChange={() => toggleTemplate(tmpl)}
                                trackColor={{ false: colors.border, true: color + '66' }}
                                thumbColor={tmpl.enabled ? color : '#fff'}
                                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                              />
                              <FontAwesome5 name={isExpanded ? 'chevron-up' : 'chevron-down'} size={10} color={colors.textLight} />
                            </View>
                          </TouchableOpacity>

                          {/* Expanded */}
                          {isExpanded && (
                            <View style={styles.templateExpanded}>
                              {/* Subject */}
                              <Text style={styles.fieldLabel}>Subject</Text>
                              <TextInput
                                style={styles.fieldInput}
                                value={isEditing ? editingTemplate.subject : tmpl.subject}
                                onChangeText={v => setEditingTemplate({ ...(editingTemplate ?? tmpl), subject: v })}
                                onFocus={() => !editingTemplate && setEditingTemplate(tmpl)}
                                placeholderTextColor={colors.textLight}
                              />

                              {/* Body */}
                              <Text style={styles.fieldLabel}>Body HTML</Text>
                              <TextInput
                                style={[styles.fieldInput, { height: 140, textAlignVertical: 'top' }]}
                                value={isEditing ? editingTemplate.body_html : tmpl.body_html}
                                onChangeText={v => setEditingTemplate({ ...(editingTemplate ?? tmpl), body_html: v })}
                                onFocus={() => !editingTemplate && setEditingTemplate(tmpl)}
                                multiline
                                placeholderTextColor={colors.textLight}
                              />

                              {/* Variables */}
                              {tmpl.variables?.length > 0 && (
                                <View style={styles.varsRow}>
                                  <Text style={styles.varsLabel}>Variables: </Text>
                                  {tmpl.variables.map(v => (
                                    <View key={v} style={styles.varChip}>
                                      <Text style={styles.varChipText}>{`{{${v}}}`}</Text>
                                    </View>
                                  ))}
                                </View>
                              )}

                              {/* Actions */}
                              <View style={styles.templateActions}>
                                {isEditing && (
                                  <TouchableOpacity
                                    style={[styles.actionBtn, { backgroundColor: color }]}
                                    onPress={saveTemplate}
                                    disabled={savingTemplate}
                                  >
                                    {savingTemplate
                                      ? <ActivityIndicator color="#fff" size="small" />
                                      : <Text style={styles.actionBtnText}>Save changes</Text>
                                    }
                                  </TouchableOpacity>
                                )}
                                {isEditing && (
                                  <TouchableOpacity
                                    style={[styles.actionBtn, { backgroundColor: colors.border }]}
                                    onPress={() => setEditingTemplate(null)}
                                  >
                                    <Text style={[styles.actionBtnText, { color: colors.textPrimary }]}>Cancel</Text>
                                  </TouchableOpacity>
                                )}
                                <TouchableOpacity
                                  style={[styles.actionBtn, { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE' }]}
                                  onPress={() => sendTestEmail(isEditing ? editingTemplate! : tmpl)}
                                  disabled={sendingTest === tmpl.id}
                                >
                                  {sendingTest === tmpl.id
                                    ? <ActivityIndicator color={colors.accent} size="small" />
                                    : <Text style={[styles.actionBtnText, { color: '#1D4ED8' }]}>Send test</Text>
                                  }
                                </TouchableOpacity>
                              </View>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                );
              })
          }
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── FOOTER TAB ── */}
      {tab === 'footer' && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
            {loadingSettings
              ? <LoadingState accent={colors.accent} />
              : (
                <>
                  <View style={styles.settingsCard}>
                    <Text style={styles.settingsCardTitle}>Email footer</Text>
                    <Text style={styles.settingsCardSub}>Appended to the bottom of every email.</Text>

                    {([
                      { field: 'footer_sign_off',  label: 'Sign-off',     placeholder: 'Thanks,' },
                      { field: 'footer_signature',  label: 'Signature',    placeholder: 'The OneShetland Team' },
                      { field: 'footer_tagline',    label: 'Tagline',      placeholder: 'Everything Shetland, All in One Place' },
                      { field: 'footer_promo_text', label: 'Promo text',   placeholder: 'Download the app →' },
                      { field: 'footer_promo_url',  label: 'Promo URL',    placeholder: 'https://oneshetland.com/app' },
                      { field: 'footer_legal',      label: 'Legal line',   placeholder: 'OneShetland · Shetland Islands · Scotland' },
                    ] as { field: keyof EmailSettings; label: string; placeholder: string }[]).map(({ field, label, placeholder }) => (
                      <View key={field} style={styles.fieldGroup}>
                        <Text style={styles.fieldLabel}>{label}</Text>
                        <TextInput
                          style={styles.fieldInput}
                          value={(settingsDraft[field] as string) ?? ''}
                          onChangeText={v => setSettingsDraft(d => ({ ...d, [field]: v }))}
                          placeholder={placeholder}
                          placeholderTextColor={colors.textLight}
                          autoCapitalize="none"
                        />
                      </View>
                    ))}
                  </View>

                  <Button
                    label="Save footer"
                    onPress={saveSettings}
                    color={colors.accent}
                    loading={savingSettings}
                    disabled={savingSettings}
                    fullWidth
                    style={styles.saveBtn}
                  />
                </>
              )
            }
            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* ── LOG TAB ── */}
      {tab === 'log' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadLog(); }} tintColor={colors.accent} />}
        >
          {/* Filter */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={styles.filterRowContent}>
            {['all', 'sent', 'delivered', 'bounced', 'failed', 'skipped'].map(f => (
              <TouchableOpacity
                key={f}
                style={[styles.filterChip, logFilter === f && { backgroundColor: colors.navy, borderColor: colors.navy }]}
                onPress={() => { Haptics.selectionAsync(); setLogFilter(f); }}
              >
                <Text style={[styles.filterChipText, logFilter === f && { color: '#fff' }]}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {loadingLog
            ? <LoadingState accent={colors.accent} />
            : log.length === 0
              ? <EmptyState icon="inbox" title="No emails logged yet" body="Sent, bounced and failed emails will appear here." accent={colors.accent} variant="card" />
              : log.map(entry => (
                <View key={entry.id} style={styles.logRow}>
                  <View style={styles.logRowLeft}>
                    <View style={[styles.logStatusDot, { backgroundColor: STATUS_COLORS[entry.status] ?? colors.textLight }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.logSubject} numberOfLines={1}>{entry.subject}</Text>
                      <Text style={styles.logMeta}>{entry.recipient_email} · {entry.template_key}</Text>
                      {entry.error_message && (
                        <Text style={styles.logError} numberOfLines={1}>{entry.error_message}</Text>
                      )}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 3 }}>
                    <View style={[styles.statusPill, { backgroundColor: (STATUS_COLORS[entry.status] ?? colors.textLight) + '22' }]}>
                      <Text style={[styles.statusPillText, { color: STATUS_COLORS[entry.status] ?? colors.textLight }]}>{entry.status}</Text>
                    </View>
                    <Text style={styles.logTime}>
                      {new Date(entry.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                </View>
              ))
          }
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── SETTINGS TAB ── */}
      {tab === 'settings' && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
            {loadingSettings
              ? <LoadingState accent={colors.accent} />
              : (
                <>
                  <View style={styles.settingsCard}>
                    <Text style={styles.settingsCardTitle}>Sender settings</Text>
                    <Text style={styles.settingsCardSub}>Shown as the "From" on every email.</Text>

                    {([
                      { field: 'from_name',  label: 'From name',  placeholder: 'OneShetland' },
                      { field: 'from_email', label: 'From email', placeholder: 'orders@oneshetland.com' },
                      { field: 'reply_to',   label: 'Reply-to',   placeholder: 'hello@oneshetland.com (optional)' },
                    ] as { field: keyof EmailSettings; label: string; placeholder: string }[]).map(({ field, label, placeholder }) => (
                      <View key={field} style={styles.fieldGroup}>
                        <Text style={styles.fieldLabel}>{label}</Text>
                        <TextInput
                          style={styles.fieldInput}
                          value={(settingsDraft[field] as string) ?? ''}
                          onChangeText={v => setSettingsDraft(d => ({ ...d, [field]: v }))}
                          placeholder={placeholder}
                          placeholderTextColor={colors.textLight}
                          autoCapitalize="none"
                          keyboardType={field === 'from_name' ? 'default' : 'email-address'}
                        />
                      </View>
                    ))}
                  </View>

                  <View style={[styles.settingsCard, { marginTop: 12 }]}>
                    <Text style={styles.settingsCardTitle}>Postmark</Text>
                    <View style={styles.postmarkInfo}>
                      <FontAwesome5 name="check-circle" size={13} color="#10B981" solid />
                      <Text style={styles.postmarkInfoText}>API key configured as a Supabase secret (POSTMARK_API_KEY)</Text>
                    </View>
                    <View style={styles.postmarkInfo}>
                      <FontAwesome5 name="info-circle" size={13} color={colors.accent} solid />
                      <Text style={styles.postmarkInfoText}>To rotate the API key, run: npx supabase secrets set POSTMARK_API_KEY=new-key</Text>
                    </View>
                  </View>

                  <Button
                    label="Save settings"
                    onPress={saveSettings}
                    color={colors.accent}
                    loading={savingSettings}
                    disabled={savingSettings}
                    fullWidth
                    style={{ ...styles.saveBtn, marginTop: 12 }}
                  />
                </>
              )
            }
            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </ScreenScaffold>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md },

  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.navyDark,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    gap: 4,
  },
  tabBtn:       { flex: 1, paddingVertical: 8, borderRadius: radius.sm, alignItems: 'center' },
  tabBtnActive: { backgroundColor: 'rgba(255,255,255,0.12)' },
  tabLabel:       { fontSize: fontSize.xs, fontWeight: '700', color: 'rgba(255,255,255,0.5)' },
  tabLabelActive: { color: '#fff' },

  // Test email
  testEmailCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  testEmailInput: {
    flex: 1, fontSize: fontSize.sm, color: colors.textPrimary,
  },

  // Category
  categoryBlock:  { marginBottom: spacing.lg },
  categoryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderLeftWidth: 3, paddingLeft: 10, marginBottom: spacing.sm },
  categoryLabel:  { fontSize: fontSize.sm, fontWeight: '900', letterSpacing: 0.3 },
  categoryCount:  { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  // Template card
  templateCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 8, overflow: 'hidden',
  },
  templateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12,
  },
  templateRowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  templateLabel:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  templateDesc:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  streamPill:       { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  streamText:       { fontSize: 9, fontWeight: '800' },

  // Template expanded
  templateExpanded: {
    paddingHorizontal: 12, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: colors.border,
    gap: 8,
  },
  fieldGroup:  { gap: 4 },
  fieldLabel:  { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  fieldInput:  {
    backgroundColor: colors.screenBackground, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 10, paddingVertical: 8,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },

  varsRow:     { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 },
  varsLabel:   { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  varChip:     { backgroundColor: '#EFF6FF', paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  varChipText: { fontSize: 11, color: '#1D4ED8', fontWeight: '700', fontFamily: 'Courier' },

  templateActions: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  actionBtn:     { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full },
  actionBtnText: { fontSize: fontSize.xs, fontWeight: '800', color: '#fff' },

  // Settings / Footer
  settingsCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 4,
  },
  settingsCardTitle: { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary, marginBottom: 2 },
  settingsCardSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 8 },

  postmarkInfo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  postmarkInfoText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17 },

  saveBtn: { marginTop: spacing.md },

  // Log
  filterRow:        { marginBottom: spacing.md },
  filterRowContent: { gap: 8, paddingRight: spacing.md },
  filterChip:       { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff' },
  filterChipText:   { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },

  logRow: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, gap: 8,
  },
  logRowLeft:    { flexDirection: 'row', alignItems: 'flex-start', gap: 10, flex: 1 },
  logStatusDot:  { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  logSubject:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  logMeta:       { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  logError:      { fontSize: fontSize.xs, color: colors.error, marginTop: 2 },
  logTime:       { fontSize: 10, color: colors.textLight },

  statusPill:     { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  statusPillText: { fontSize: 10, fontWeight: '800' },
});
