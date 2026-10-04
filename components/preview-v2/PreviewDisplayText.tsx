/**
 * PreviewDisplayText — the V2 previews' display typography: Fraunces, as on the web.
 *
 * Why this exists instead of components/DisplayText.tsx: that shared component requires
 * '@expo-google-fonts/fraunces/Fraunces_900Black.ttf' etc. The installed package (0.4.1) keeps each file in a
 * subfolder ('900Black/Fraunces_900Black.ttf'), so every one of those requires throws, the try/catch swallows it
 * as "package not installed", and the component silently falls back to bold sans-serif everywhere. The shipped
 * Release bundle contains no Fraunces files at all. This preview component uses the real paths, so the previews
 * show the intended typeface; the shared component is deliberately left alone (changing it is a production change).
 *
 * Same props as DisplayText (weight: 'bold' | 'black', italic), so screens swap by changing one import.
 */
import React, { useEffect, useState } from 'react';
import { Text, TextProps, TextStyle, StyleProp } from 'react-native';
import * as Font from 'expo-font';

/* eslint-disable @typescript-eslint/no-require-imports */
const FILES: Record<string, number> = {
  'Fraunces-Bold': require('@expo-google-fonts/fraunces/700Bold/Fraunces_700Bold.ttf'),
  'Fraunces-Black': require('@expo-google-fonts/fraunces/900Black/Fraunces_900Black.ttf'),
  'Fraunces-Black-Italic': require('@expo-google-fonts/fraunces/900Black_Italic/Fraunces_900Black_Italic.ttf'),
};

let loaded = false;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
function load(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = Font.loadAsync(FILES).then(() => { loaded = true; subs.forEach((s) => s()); });
  }
  return loading;
}

export function DisplayText({ weight = 'black', italic, style, ...rest }: TextProps & { weight?: 'black' | 'bold'; italic?: boolean; style?: StyleProp<TextStyle> }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (loaded) return;
    const cb = () => force((n) => n + 1);
    subs.add(cb);
    void load();
    return () => { subs.delete(cb); };
  }, []);
  const family = loaded ? (italic && weight === 'black' ? 'Fraunces-Black-Italic' : weight === 'bold' ? 'Fraunces-Bold' : 'Fraunces-Black') : undefined;
  return <Text style={[family ? { fontFamily: family } : { fontWeight: weight === 'bold' ? '700' : '900', letterSpacing: -0.4 }, style]} {...rest} />;
}

export default DisplayText;
