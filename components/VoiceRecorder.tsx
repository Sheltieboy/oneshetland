/**
 * components/VoiceRecorder.tsx
 *
 * Drop-in voice-note recorder for memory creation. Records via expo-av,
 * shows an elapsed-time read-out and a level meter, and calls back with
 * a PickedFile when the user finishes recording.
 *
 * Why soft-load expo-av?
 *   The app may not yet have the dependency installed when this commit
 *   first lands. Instead of crashing the screen at import time we
 *   gracefully alert the user and rendering shows a disabled state.
 *
 *   Run:   npx expo install expo-av
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

interface VoiceRecorderProps {
  onFinish:  (file: PickedFile, durationSeconds: number) => void;
  onCancel?: () => void;
  /** Soft cap, in seconds. Default 10 minutes. Recording auto-stops. */
  maxSeconds?: number;
}

const SECTION = SECTIONS.memories;

// Soft-load expo-av.
let Audio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Audio = require('expo-av').Audio;
} catch {
  Audio = null;
}

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceRecorder({ onFinish, onCancel, maxSeconds = 600 }: VoiceRecorderProps) {
  const [state, setState]       = useState<'idle' | 'preparing' | 'recording' | 'stopping'>('idle');
  const [elapsed, setElapsed]   = useState(0);
  const [meter, setMeter]       = useState(0);   // 0..1 for the bar
  const recordingRef            = useRef<any>(null);
  const tickRef                 = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      // Best-effort tidy up if the user navigates away mid-recording.
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync?.().catch(() => {});
      }
    };
  }, []);

  const start = async () => {
    if (!Audio) {
      Alert.alert(
        'Setup needed',
        'Voice recording is not installed yet. Run `npx expo install expo-av` and rebuild the app.',
      );
      return;
    }
    try {
      setState('preparing');
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          'Microphone needed',
          'OneShetland needs microphone access to record voice notes.',
        );
        setState('idle');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);

      recording.setOnRecordingStatusUpdate((status: any) => {
        if (typeof status?.metering === 'number') {
          // metering is in dB; map roughly -60..0 → 0..1
          const norm = Math.max(0, Math.min(1, (status.metering + 60) / 60));
          setMeter(norm);
        }
      });
      await recording.startAsync();

      recordingRef.current = recording;
      setState('recording');
      setElapsed(0);

      tickRef.current = setInterval(() => {
        setElapsed(prev => {
          const next = prev + 1;
          if (next >= maxSeconds) {
            void stop();
          }
          return next;
        });
      }, 1000);
    } catch (err: any) {
      Alert.alert('Could not start recording', err?.message ?? 'Please try again.');
      setState('idle');
    }
  };

  const stop = async () => {
    if (!recordingRef.current) return;
    setState('stopping');
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      const status = await recordingRef.current.getStatusAsync().catch(() => null);
      const duration = status?.durationMillis ? Math.round(status.durationMillis / 1000) : elapsed;
      const file: PickedFile = {
        uri,
        mimeType: 'audio/m4a',
        ext: 'm4a',
      };
      recordingRef.current = null;
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
