import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { STATES, type PreviewState, type PreviewViewer } from './model';

/** The preview chrome: content state, viewer, and a hop between Home and Local. Not part of the design. */
export function PreviewSwitch({ route, state, viewer }: { route: 'home-v2' | 'local-v2'; state: PreviewState; viewer: PreviewViewer }) {
  const router = useRouter();
  const go = (path: string, s: PreviewState, v: PreviewViewer) => router.setParams({ state: s, as: v });
  const pill = (on: boolean) => ({ backgroundColor: on ? '#fff' : 'rgba(255,255,255,0.12)', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 });
  const txt = (on: boolean) => ({ color: on ? '#0F172A' : 'rgba(255,255,255,0.82)', fontSize: 11, fontWeight: '800' as const });
  return (
    <View style={{ backgroundColor: '#0F172A', paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ backgroundColor: '#FBBF24', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}><Text style={{ fontSize: 9, fontWeight: '900', letterSpacing: 0.8 }}>DESIGN PREVIEW · NOT LIVE</Text></View>
        <Pressable onPress={() => router.replace({ pathname: (route === 'home-v2' ? '/preview/local-v2' : '/preview/home-v2') as never, params: { state, as: viewer } })}>
          <Text style={{ color: '#FCD34D', fontSize: 11, fontWeight: '800' }}>{route === 'home-v2' ? 'Local V2 →' : 'Home V2 →'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
        {STATES.map((s) => <Pressable key={s.key} onPress={() => go(route, s.key, viewer)} style={pill(state === s.key)}><Text style={txt(state === s.key)}>{s.label}</Text></Pressable>)}
        <View style={{ width: 1, height: 16, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: 2 }} />
        <Pressable onPress={() => go(route, state, 'public')} style={pill(viewer === 'public')}><Text style={txt(viewer === 'public')}>Public</Text></Pressable>
        <Pressable onPress={() => go(route, state, 'admin')} style={pill(viewer === 'admin')}><Text style={txt(viewer === 'admin')}>Admin QA</Text></Pressable>
      </ScrollView>
    </View>
  );
}
