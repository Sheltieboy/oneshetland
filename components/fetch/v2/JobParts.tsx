/**
 * Fetch v2 — pieces shared by the requester's and the driver's job screens (Step 12): messages, report a problem, photos, the bank's check.
 * Every change is one call through lib/fetch-api.ts; the screen shows the server's answer and refreshes only after a success.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import { spacing } from '@/constants/theme';
import type { IssueKind, Message, Photo, PhotoKind } from '@/lib/fetch-api';
import { ISSUE_KINDS } from '@/lib/fetch/present';
import { fetchApi } from '@/lib/fetch/transport';
import { confirmWithBank, fetchKey, pickFetchPhoto, uploadFetchPhoto } from '@/lib/fetch/device';
import { Check, Choice, FButton, Field, Notice, s, stamp } from '@/components/fetch/v2/ui';

/** Requester ↔ current driver, plain text, through OneShetland. Refreshed every 15 s while the job is on screen. */
export function Messages({ requestId, initial, canSend, otherName }: { requestId: string; initial: Message[]; canSend: boolean; otherName: string }) {
  const [list, setList] = useState(initial);
  const [send, setSend] = useState(canSend);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(fetchKey());

  const reload = useCallback(async () => {
    const r = await fetchApi.messages(requestId).catch(() => null);
    if (r?.ok) { setList(r.data.messages); setSend(r.data.can_send); }
  }, [requestId]);
  useFocusEffect(useCallback(() => {
    const t = setInterval(() => { if (AppState.currentState === 'active') reload(); }, 15_000);
    return () => clearInterval(t);
  }, [reload]));

  async function submit() {
    if (!text.trim()) { setError('Please write a message.'); return; }
    setBusy(true); setError(null);
    // The same reference on a retry is the same message, never two.
    const r = await fetchApi.sendMessage(requestId, text.trim(), ref.current).catch(() => null);
    setBusy(false);
    if (!r) { setError("We couldn't send that. Please try again."); return; }
    if (!r.ok) { setError(r.message); return; }
    setText(''); ref.current = fetchKey(); reload();
  }

  return (
    <View>
      {list.length === 0 && <Text style={s.muted}>No messages yet.</Text>}
      {list.map((m) => (
        <View key={m.id} accessible accessibilityLabel={`${m.from === 'you' ? 'You' : otherName}, ${stamp(m.created_at)}: ${m.hidden ? 'Message removed' : m.body}`}
          style={{ alignSelf: m.from === 'you' ? 'flex-end' : 'flex-start', maxWidth: '88%', backgroundColor: m.from === 'you' ? '#FFEDD5' : '#F1EFEA', borderRadius: 14, padding: spacing.sm, marginBottom: spacing.sm }}>
          <Text style={s.muted}>{m.from === 'you' ? 'You' : otherName} · {stamp(m.created_at)}</Text>
          {m.hidden ? <Text style={[s.body, { fontStyle: 'italic' }]}>Message removed</Text> : <Text style={s.bodyStrong}>{m.body}</Text>}
        </View>
      ))}
      {send ? (
        <View style={{ marginTop: spacing.sm }}>
          <Field label={`Message ${otherName}`} value={text} onChangeText={setText} maxLength={1000} multiline
            hint="Keep it to the Fetch. Messages are kept by OneShetland and can be read if a problem is reported." />
          {error && <Notice tone="error">{error}</Notice>}
          <FButton label="Send" onPress={submit} busy={busy} busyLabel="Sending…" />
        </View>
      ) : <Text style={s.muted}>Messages for this Fetch have closed.</Text>}
    </View>
  );
}

/** Report a problem (both parties, up to 72 hours after the Fetch finishes) with an optional photo. */
export function ReportProblem({ requestId, viewer, onDone }: { requestId: string; viewer: 'requester' | 'driver'; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string | undefined>();
  const [detail, setDetail] = useState('');
  const [withPhoto, setWithPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const ref = useRef(fetchKey());
  const kinds = ISSUE_KINDS.filter((k) => k.who === 'both' || k.who === viewer);

  async function submit() {
    if (!kind) { setResult({ ok: false, msg: 'Please choose what kind of problem it is.' }); return; }
    setBusy(true); setResult(null);
    const r = await fetchApi.reportProblem(requestId, kind as IssueKind, detail.trim(), ref.current).catch(() => null);
    if (!r || !r.ok) { setBusy(false); setResult({ ok: false, msg: r?.message ?? "We couldn't send that. Please try again." }); return; }
    let msg = 'Thank you — OneShetland has your report and will be in touch.';
    if (withPhoto) {
      const picked = await pickFetchPhoto('library');
      if (picked && !picked.ok) msg += ` Your photo wasn't added: ${picked.message}`;
      if (picked?.ok) {
        const up = await uploadFetchPhoto(picked.photo, (m, sz) => fetchApi.photoBeginUpload(requestId, 'issue', m, sz, { issueId: r.data.issue_id }), (u) => fetchApi.photoSubmit(u));
        if (!up.ok) msg += ` Your photo wasn't added: ${up.message}`;
      }
    }
    setBusy(false); setResult({ ok: true, msg }); ref.current = fetchKey(); onDone();
  }

  if (!open) return <FButton label="Report a problem" kind="secondary" onPress={() => setOpen(true)} />;
  return (
    <View>
      <Choice label="What's wrong?" value={kind} options={kinds.map((k) => ({ value: k.value, label: k.label }))} onChange={setKind} />
      <Field label="Tell us what happened (optional)" value={detail} onChangeText={setDetail} maxLength={2000} multiline />
      <Check label="Add a photo after sending" value={withPhoto} onChange={setWithPhoto} />
      <Text style={[s.muted, { marginBottom: spacing.sm }]}>For anything urgent or unsafe, call 999 first. Problems can be reported up to 72 hours after a Fetch finishes.</Text>
      {result && <Notice tone={result.ok ? 'ok' : 'error'}>{result.msg}</Notice>}
      {!result?.ok && <View style={{ gap: spacing.sm }}>
        <FButton label="Send report" onPress={submit} busy={busy} busyLabel="Sending…" />
        <FButton label="Not now" kind="secondary" onPress={() => setOpen(false)} />
      </View>}
    </View>
  );
}

const PHOTO_LABEL: Record<PhotoKind, string> = { item: 'Item', collection: 'At collection', delivery: 'At delivery', return: 'Returned', issue: 'With a report' };

/** Photos on a job: add (camera or library, prepared on the device), open through a short-lived link, and manage item photos before acceptance. */
export function PhotoSection({ requestId, photos, addKinds, manageItem, onChange }: {
  requestId: string; photos: Photo[]; addKinds: PhotoKind[]; manageItem: boolean; onChange: () => void;
}) {
  const [kind, setKind] = useState<PhotoKind | undefined>(addKinds.length === 1 ? addKinds[0] : undefined);
  const [onBoard, setOnBoard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function add(source: 'camera' | 'library') {
    if (!kind) return;
    setMsg(null);
    const picked = await pickFetchPhoto(source);
    if (!picked) return;
    if (!picked.ok) { setMsg({ ok: false, text: picked.message }); return; }
    setBusy(true);
    const up = await uploadFetchPhoto(picked.photo, (m, sz) => fetchApi.photoBeginUpload(requestId, kind, m, sz, { showOnBoard: kind === 'item' && onBoard }), (u) => fetchApi.photoSubmit(u));
    setBusy(false);
    setMsg(up.ok ? { ok: true, text: 'Photo added.' } : { ok: false, text: up.message });
    if (up.ok) onChange();
  }
  async function view(id: string) {
    const r = await fetchApi.photoView(id).catch(() => null);
    if (r?.ok) Linking.openURL(r.data.url); else setMsg({ ok: false, text: r?.message ?? "We couldn't open that photo." });
  }
  async function change(id: string, action: 'show_on_board' | 'hide_from_board' | 'withdraw') {
    const r = await fetchApi.setItemPhoto(requestId, id, action).catch(() => null);
    if (r?.ok) onChange(); else setMsg({ ok: false, text: r?.message ?? "That didn't work. Please try again." });
  }

  return (
    <View>
      {photos.length === 0 ? <Text style={s.muted}>No photos yet.</Text> : photos.map((p) => (
        <View key={p.id} style={{ paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: '#E5E9EF' }}>
          <Text style={s.bodyStrong}>{PHOTO_LABEL[p.kind]}</Text>
          <Text style={s.muted}>{stamp(p.created_at)}{p.kind === 'item' ? (p.matching_visible ? ' · shown to drivers' : ' · not shown to drivers') : ''}</Text>
          <View style={[s.row, { flexWrap: 'wrap' }]}>
            <FButton label="View" kind="quiet" onPress={() => view(p.id)} />
            {manageItem && p.kind === 'item' && p.mine && <>
              <FButton label={p.matching_visible ? 'Hide from drivers' : 'Show to drivers'} kind="quiet" onPress={() => change(p.id, p.matching_visible ? 'hide_from_board' : 'show_on_board')} />
              <FButton label="Remove" kind="quiet" onPress={() => change(p.id, 'withdraw')} />
            </>}
          </View>
        </View>
      ))}
      {addKinds.length > 0 && (
        <View style={{ marginTop: spacing.md }}>
          {addKinds.length > 1 && <Choice label="What is this photo of?" value={kind} options={addKinds.map((k) => ({ value: k, label: PHOTO_LABEL[k] }))} onChange={setKind} />}
          {kind === 'item' && <Check label="Show this photo to drivers looking at the Fetch" value={onBoard} onChange={setOnBoard} />}
          <View style={{ gap: spacing.sm }}>
            <FButton label="Take a photo" kind="secondary" onPress={() => add('camera')} disabled={!kind} busy={busy} busyLabel="Uploading…" />
            <FButton label="Choose a photo" kind="secondary" onPress={() => add('library')} disabled={!kind || busy} />
          </View>
          <Text style={[s.muted, { marginTop: spacing.sm }]}>Photos are private to you, the other person on this Fetch and OneShetland. Links to them last two minutes.</Text>
        </View>
      )}
      {msg && <View style={{ marginTop: spacing.sm }}><Notice tone={msg.ok ? 'ok' : 'error'}>{msg.text}</Notice></View>}
    </View>
  );
}

/** The bank's check (3D Secure) on the requester's payment authorisation. The server's state decides what we say. */
export function PaymentConfirm({ requestId, paymentStatus, onDone, openPayments }: { requestId: string; paymentStatus: string; onDone: () => void; openPayments: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (paymentStatus === 'requires_payment_method') {
    return (
      <View>
        <Notice tone="warn">Your card was declined. Please update your card in your payments. If it isn't sorted in time, your Fetch goes back to other drivers — nothing is charged.</Notice>
        <FButton label="Open my payments" kind="secondary" onPress={openPayments} />
      </View>
    );
  }
  async function go() {
    setBusy(true); setMsg(null);
    const r = await confirmWithBank(requestId).catch(() => ({ ok: false, text: "We couldn't reach OneShetland. Please try again." }));
    setBusy(false); setMsg(r); onDone();
  }
  return (
    <View>
      <Text style={s.bodyStrong}>Your bank needs you to confirm this payment authorisation.</Text>
      <Text style={[s.muted, { marginBottom: spacing.sm }]}>Nothing is charged until delivery — this only reserves the amount.</Text>
      <FButton label="Confirm with my bank" onPress={go} busy={busy} busyLabel="Opening your bank's check…" />
      {msg && <View style={{ marginTop: spacing.sm }}><Notice tone={msg.ok ? 'ok' : 'error'}>{msg.text}</Notice></View>}
    </View>
  );
}
