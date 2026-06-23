/**
 * components/VoiceRecorder.tsx
 *
 * Drop-in voice-note recorder for memory creation. Records via expo-audio
 * (the SDK 54+ replacement for the removed expo-av), shows an elapsed-time
 * read-out, and calls back with a PickedFile when the user finishes.
 *
 * expo-audio is a NATIVE module: it only works once it has been compiled
 * into the dev client / app build. We therefore *soft-load* it with a
 * try/catch require — if the running build predates the install, the module
 * throws "Cannot find native module 'ExpoAudio'" at import time. Catching it
 * lets the rest of the screen (create / edit a memory, add photos & video)
 * keep working; we just show a "needs the latest build" notice in place of
 * the record button instead of red-screening the whole screen.
 *
 *   npx expo install expo-audio   →   rebuild the dev client / EAS build.
 *
 * Output:
 *   onFinish(file, durationSeconds)  — pass to uploadMemoryMedia() with
 *                                      kind: 'audio'.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { PickedFile } from '@/lib/image-upload';

// Soft-load the native audio module. A build that predates the expo-audio
// install throws synchronously here; we degrade gracefully instead.
let ExpoAudio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExpoAudio = require('expo-audio');
} catch {
  ExpoAudio = null;
}

const AUDIO_AVAILABLE = !!ExpoAudio?.useAudioRecorder;

interface VoiceRecorderProps {
  onFinish:  (file: PickedFile, durationSeconds: number) => void;
  onCancel?: () => void;
  /** Soft cap, in seconds. Default 10 minutes. Recording auto-stops. */
  maxSeconds?: number;
}

const SECTION = SECTIONS.memories;

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Public component. When the native module is missing we render a friendly
 * notice; otherwise we mount the real recorder, which calls expo-audio
 * hooks. Splitting like this keeps the hook calls unconditional inside the
 * inner component (so we never break the rules of hooks).
 */
export function VoiceRecorder(props: VoiceRecorderProps) {
  if (!AUDIO_AVAILABLE) {
    return (
      <View style={styles.unavailableWrap}>
        <FontAwesome5 name="microphone-slash" size={18} color={colors.textMuted} />
        <Text style={styles.unavailableTitle}>Voice recording needs the latest build</Text>
        <Text style={styles.unavailableBody}>
          Your app is running an older build that doesn&apos;t include the voice
          module yet. Update to the newest OneShetland build to record voice
          notes. You can still add photos, video and text.
        </Text>
        {props.onCancel ? (
          <TouchableOpacity onPress={props.onCancel} style={styles.cancelBtn}>
            <Text style={styles.cancelBtnText}>Close</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  return <VoiceRecorderInner {...props} />;
}

function VoiceRecorderInner({ onFinish, onCancel, maxSeconds = 600 }: VoiceRecorderProps) {
  const recorder                = ExpoAudio.useAudioRecorder(ExpoAudio.RecordingPresets.HIGH_QUALITY);
  const [state, setState]       = useState<'idle' | 'preparing' | 'recording' | 'stopping'>('idle');
  const [elapsed, setElapsed]   = useState(0);
  const meter = state === 'recording' ? 0.55 : 0;
  const tickRef                 = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingFlag           = useRef(false);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (recordingFlag.current) recorder.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    try {
      setState('preparing');
      const perm = await ExpoAudio.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Microphone needed', 'OneShetland needs microphone access to record voice notes.');
        setState('idle');
        return;
      }
      await ExpoAudio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingFlag.current = true;
      setState('recording');
      setElapsed(0);

      tickRef.current = setInterval(() => {
        setElapsed(prev => {
          const next = prev + 1;
          if (next >= maxSeconds) void stop();
          return next;
        });
      }, 1000);
    } catch (err: any) {
      Alert.alert('Could not start recording', err?.message ?? 'Please update to the latest app build and try again.');
      setState('idle');
    }
  };

  const stop = async () => {
    if (!recordingFlag.current) return;
    setState('stopping');
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try {
      const duration = recorder.getStatus?.()?.durationMillis
        ? Math.round(recorder.getStatus().durationMillis / 1000)
        : elapsed;
      await recorder.stop();
      recordingFlag.current = false;
      const uri = recorder.uri;
      if (!uri) throw new Error('No recording was captured.');
      const file: PickedFile = { uri, mimeType: 'audio/m4a', ext: 'm4a' };
      setState('idle');
      onFinish(file, duration);
    } catch (err: any) {
      Alert.alert('Could not save recording', err?.message ?? 'Please try again.');
      setState('idle');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (state === 'recording' || state === 'stopping') {
    return (
      <View style={styles.activeWrap}>
        <View style={styles.activeRow}>
          <View style={styles.recDot} />
          <Text style={styles.activeTime}>{fmtTime(elapsed)}</Text>
          <Text style={styles.activeHint}>recording…</Text>
        </View>

        {/* Meter bar */}
        <View style={styles.meterTrack}>
          <View
            style={[
              styles.meterFill,
              {
                width: `${Math.max(8, meter * 100)}%`,
                backgroundColor: SECTION.color,
              },
            ]}
          />
        </View>

        <TouchableOpacity onPress={stop} disabled={state === 'stopping'} style={styles.stopBtn}>
          {state === 'stopping' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <FontAwesome5 name="stop" size={14} color="#fff" solid />
              <Text style={styles.stopBtnText}>Stop & attach</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.idleWrap}>
      <TouchableOpacity
        onPress={start}
        disabled={state === 'preparing'}
        style={[styles.recBtn, { backgroundColor: SECTION.color }]}
      >
        {state === 'preparing' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <FontAwesome5 name="microphone" size={16} color="#fff" />
            <Text style={styles.recBtnText}>Record voice note</Text>
          </>
        )}
      </TouchableOpacity>
      <Text style={styles.idleHint}>
        Voice notes are transcribed automatically so they're searchable later.
      </Text>
      {onCancel ? (
        <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  idleWrap: {
    gap: spacing.sm,
    alignItems: 'center',
  },
  unavailableWrap: {
    gap: spacing.xs,
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.offWhite,
  },
  unavailableTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
    marginTop: 4,
    textAlign: 'center',
  },
  unavailableBody: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },
  recBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignSelf: 'stretch',
  },
  recBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.md,
  },
  idleHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
  },
  cancelBtn: {
    paddingVertical: spacing.sm,
  },
  cancelBtnText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  activeWrap: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.darkSurface,
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EF4444',
  },
  activeTime: {
    color: '#fff',
    fontWeight: '800',
    fontSize: fontSize.lg,
  },
  activeHint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.sm,
  },
  meterTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: 3,
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: '#EF4444',
  },
  stopBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
});

export default VoiceRecorder;
