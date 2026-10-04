import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { STATES, type PreviewState, type PreviewViewer } from './model';

/**
 * Review chrome, not part of the design: content state + viewer. A small floating chip (bottom-left, above the tab
 * bar) that opens a panel — so it takes NO layout space and the screen keeps its true viewport height.
 */
export function PreviewSwitch({ route, state, viewer }: { route: 'home-v2' | 'local-v2'; state: PreviewState; viewer: PreviewViewer }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const go = (s: PreviewState, v: PreviewViewer) => router.setParams({ state: s, as: v });
  const pill = (on: boolean) => ({ backgroundColor: on ? '#fff' : 'rgba(255,255,255,0.14)', borderRadius: 99, paddingHorizontal: 11, paddingVertical: 7 });
  const txt = (on: boolean) => ({ color: on ? '#0F172A' : 'rgba(255,255,255,0.88)', fontSize: 12, fontWeight: '800' as const });
  const label = `${STATES.find((x) => x.key === state)?.label ?? state} · ${viewer === 'admin' ? 'Admin QA' : 'Public'}`;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 50 }}>
      {open && (
        <View style={{ backgroundColor: 'rgba(15,23,42,0.96)', borderRadius: 16, padding: 12, marginBottom: 8, gap: 8, width: 300 }}>
          <Text style={{ color: '#FCD34D', fontSize: 10, fontWeight: '900', letterSpacing: 1 }}>DESIGN PREVIEW · NOT LIVE</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {STATES.map((x) => <Pressable key={x.key} onPress={() => go(x.key, viewer)} style={pill(state === x.key)}><Text style={txt(state === x.key)}>{x.label}</Text></Pressable>)}
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Pressable onPress={() => go(state, 'public')} style={pill(viewer === 'public')}><Text style={txt(viewer === 'public')}>Public</Text></Pressable>
            <Pressable onPress={() => go(state, 'admin')} style={pill(viewer === 'admin')}><Text style={txt(viewer === 'admin')}>Admin QA</Text></Pressable>
          </View>
        </View>
      )}
      <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(15,23,42,0.88)', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 6 }}>
        <View style={{ backgroundColor: '#FBBF24', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}><Text style={{ fontSize: 8.5, fontWeight: '900', letterSpacing: 0.6 }}>PREVIEW</Text></View>
        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{label}</Text>
      </Pressable>
    </View>
  );
}
