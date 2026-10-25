/**
 * Fetch v2 — shared native presentation (Step 12). The OneShetland theme with the Fetch accent; the same words as the website.
 * Buttons are 48pt high with a role, label and disabled/busy state; status always has words and an icon, never colour alone; nothing animates.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { Sheet } from '@/components/ui/Sheet';
import type { FetchResult } from '@/lib/fetch-api';
import type { HumanStatus } from '@/lib/fetch/present';
import { pounds } from '@/lib/fetch/present';

export const FETCH = colors.fetch;
const DANGER = '#BE123C';

export function FButton({ label, onPress, kind = 'primary', disabled, busy, busyLabel, hint }: {
  label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'quiet' | 'danger'; disabled?: boolean; busy?: boolean; busyLabel?: string; hint?: string;
}) {
  const bg = kind === 'primary' ? FETCH : kind === 'danger' ? DANGER : kind === 'secondary' ? colors.white : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? colors.white : colors.navy;
  const off = disabled || busy;
  return (
    <Pressable onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: off ? 0.45 : pressed ? 0.85 : 1 },
        kind === 'secondary' && s.btnOutline, kind === 'quiet' && s.btnQuiet]}>
      {busy && <ActivityIndicator color={fg} style={{ marginRight: spacing.sm }} />}
      <Text style={[s.btnText, { color: fg }, kind === 'quiet' && { textDecorationLine: 'underline' }]} maxFontSizeMultiplier={1.6}>{busy && busyLabel ? busyLabel : label}</Text>
    </Pressable>
  );
}

const TONE: Record<HumanStatus['tone'], { bg: string; border: string; icon: string }> = {
  neutral: { bg: colors.white, border: colors.border, icon: '⏳' },
  good: { bg: colors.successLight, border: '#6EE7B7', icon: '✓' },
  attention: { bg: colors.warningLight, border: '#FCD34D', icon: '!' },
  done: { bg: colors.white, border: '#6EE7B7', icon: '✓' },
  muted: { bg: colors.offWhite, border: colors.border, icon: '–' },
};
export function StatusCard({ status }: { status: HumanStatus }) {
  const t = TONE[status.tone];
  return (
    <View accessible accessibilityRole="summary" accessibilityLabel={`${status.label}. ${status.detail}`} style={[s.card, { backgroundColor: t.bg, borderColor: t.border }]}>
      <View style={s.row}>
        <View style={s.statusIcon}><Text style={{ color: FETCH, fontWeight: '800' }}>{t.icon}</Text></View>
        <Text style={s.statusLabel}>{status.label}</Text>
      </View>
      {!!status.detail && <Text style={s.body}>{status.detail}</Text>}
    </View>
  );
}

export function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      {!!title && <Text accessibilityRole="header" style={s.panelTitle}>{title}</Text>}
      {children}
    </View>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  const c = { info: [colors.infoLight, colors.infoDark], warn: [colors.warningLight, colors.warningDark], error: [colors.errorLight, colors.errorDark], ok: [colors.successLight, colors.successDark] }[tone];
  return (
    <View accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'} accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[s.notice, { backgroundColor: c[0] }]}>
      {typeof children === 'string' ? <Text style={[s.body, { color: c[1] }]}>{children}</Text> : children}
    </View>
  );
}

export function RouteLine({ from, to, ferry }: { from: string; to: string; ferry?: boolean }) {
  return (
    <View style={[s.row, { flexWrap: 'wrap' }]} accessible accessibilityLabel={`${from} to ${to}${ferry ? ', crosses by ferry' : ''}`}>
      <Text style={s.route}>{from} → {to}</Text>
      {ferry && <Text style={s.ferry}>Ferry</Text>}
    </View>
  );
}

export function MoneyTable({ lines, total, totalLabel = 'Expected total' }: { lines: [string, number][]; total: number; totalLabel?: string }) {
  return (
    <View>
      {lines.map(([k, v]) => (
        <View key={k} style={s.moneyRow} accessible accessibilityLabel={`${k} ${pounds(v)}`}>
          <Text style={s.body}>{k}</Text><Text style={s.bodyStrong}>{pounds(v)}</Text>
        </View>
      ))}
      <View style={[s.moneyRow, s.moneyTotal]} accessible accessibilityLabel={`${totalLabel} ${pounds(total)}`}>
        <Text style={s.bodyStrong}>{totalLabel}</Text><Text style={s.total}>{pounds(total)}</Text>
      </View>
    </View>
  );
}

export function Timeline({ items }: { items: { at: string; text: string }[] }) {
  if (!items.length) return <Text style={s.muted}>Nothing yet.</Text>;
  return (
    <View>
      {items.map((e, i) => (
        <View key={i} style={[s.row, { alignItems: 'flex-start', marginBottom: spacing.sm }]} accessible accessibilityLabel={`${e.text}, ${stamp(e.at)}`}>
          <View style={s.dot} />
          <View style={{ flex: 1 }}><Text style={s.bodyStrong}>{e.text}</Text><Text style={s.muted}>{stamp(e.at)}</Text></View>
        </View>
      ))}
    </View>
  );
}
export const stamp = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export function Field({ label, hint, ...rest }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} accessibilityHint={hint} placeholderTextColor={colors.textLight} style={s.input} {...rest} />
      {!!hint && <Text style={s.muted}>{hint}</Text>}
    </View>
  );
}

/** A choice that reads as one control: radio-like rows with a label and a plain-words hint. */
export function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T | undefined; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ marginBottom: spacing.md }}>
      <Text style={s.label}>{label}</Text>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ checked: on }}
            accessibilityLabel={o.hint ? `${o.label}. ${o.hint}` : o.label} style={[s.choice, on && s.choiceOn]}>
            <View style={[s.radio, on && s.radioOn]} />
            <View style={{ flex: 1 }}><Text style={s.bodyStrong}>{o.label}</Text>{!!o.hint && <Text style={s.body}>{o.hint}</Text>}</View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} accessibilityRole="checkbox" accessibilityState={{ checked: value }} accessibilityLabel={label} style={[s.row, s.check]}>
      <View style={[s.box, value && s.boxOn]}>{value && <Text style={{ color: colors.white, fontWeight: '800' }}>✓</Text>}</View>
      <Text style={[s.body, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A button that opens a sheet saying exactly what will happen, optionally asks for a reason or a choice, then runs one server call.
 * The sheet shows the server's own answer (or its refusal in words); only a success refreshes the screen. Nothing is assumed.
 */
export function ActionSheet({ trigger, title, body, confirm, run, choices, reason, danger, primary, onDone, refresh }: {
  trigger: string; title: string; body: string; confirm: string; run: (i: { reason: string; choice: string }) => Promise<FetchResult<unknown>>;
  choices?: { label: string; options: { value: string; label: string }[] }; reason?: { label: string; required?: boolean };
  danger?: boolean; primary?: boolean; onDone?: (r: FetchResult<unknown>) => string | void; refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const missing = (reason?.required && text.trim().length < 3) || (choices && !choice);
  async function go() {
    setBusy(true); setResult(null);
    try {
      const r = await run({ reason: text.trim(), choice });
      const custom = onDone?.(r);
      setResult(r.ok ? { ok: true, msg: custom || 'Done.' } : { ok: false, msg: r.message });
      if (r.ok) refresh();
    } catch { setResult({ ok: false, msg: "We couldn't reach OneShetland. Nothing has changed — please try again." }); }
    finally { setBusy(false); }
  }
  return (
    <>
      <FButton label={trigger} kind={danger && !primary ? 'secondary' : primary ? 'primary' : 'secondary'} onPress={() => { setOpen(true); setResult(null); }} />
      <Sheet visible={open} onClose={() => setOpen(false)} title={title} scroll>
        <Text style={[s.body, { marginBottom: spacing.md }]}>{body}</Text>
        {choices && <Choice label={choices.label} value={choice || undefined} options={choices.options} onChange={setChoice} />}
        {reason && <Field label={reason.required ? reason.label : `${reason.label} (optional)`} value={text} onChangeText={setText} multiline maxLength={500} />}
        {result && <Notice tone={result.ok ? 'ok' : 'error'}>{result.msg}</Notice>}
        <View style={{ gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.lg }}>
          {!result?.ok && <FButton label={confirm} kind={danger ? 'danger' : 'primary'} onPress={go} busy={busy} busyLabel="Please wait…" disabled={!!missing} />}
          <FButton label={result?.ok ? 'Close' : 'Not now'} kind="secondary" onPress={() => setOpen(false)} />
        </View>
      </Sheet>
    </>
  );
}

export const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md },
  panelTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary, marginBottom: spacing.sm },
  body: { fontSize: fontSize.md, color: colors.textSecondary, lineHeight: 21 },
  bodyStrong: { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '600' },
  muted: { fontSize: fontSize.sm, color: colors.textMuted },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary, backgroundColor: colors.white },
  btn: { minHeight: 48, borderRadius: radius.full, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  btnOutline: { borderWidth: 1.5, borderColor: colors.borderStrong },
  btnQuiet: { minHeight: 44, paddingHorizontal: spacing.sm },
  btnText: { fontSize: fontSize.md, fontWeight: '700', textAlign: 'center' },
  statusIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  statusLabel: { flex: 1, fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  notice: { borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  route: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary, marginRight: spacing.sm },
  ferry: { fontSize: fontSize.xs, fontWeight: '800', color: colors.infoDark, backgroundColor: colors.infoLight, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full, overflow: 'hidden' },
  moneyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  moneyTotal: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4, paddingTop: 8 },
  total: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: FETCH, marginTop: 7, marginRight: spacing.sm },
  choice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, backgroundColor: colors.white },
  choiceOn: { borderColor: FETCH, backgroundColor: colors.fetchLight },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.borderStrong, marginTop: 2 },
  radioOn: { borderColor: FETCH, borderWidth: 6 },
  check: { minHeight: 48, gap: spacing.sm, marginBottom: spacing.sm },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: FETCH, borderColor: FETCH },
});
