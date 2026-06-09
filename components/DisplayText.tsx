/**
 * components/DisplayText.tsx
 *
 * Hero typography for the section landings. Uses Fraunces (a variable
 * Google serif with character) when the @expo-google-fonts/fraunces
 * package is installed; gracefully falls back to system sans-serif
 * black-weight otherwise.
 *
 * To enable Fraunces:
 *   npx expo install @expo-google-fonts/fraunces
 *
 * After install, restart Metro and reload — the font loads on first
 * mount of any DisplayText and from then on every hero title gets the
 * serif treatment. Body type stays system sans throughout the app for
 * readability.
 */

import React, { useEffect, useState } from 'react';
import { Text, TextProps, TextStyle, StyleProp } from 'react-native';
import * as Font from 'expo-font';

// ── Soft-load the font resources ─────────────────────────────────────────
//
// Both the wrapping package and individual TTF resources may be missing
// during development. Wrap each require in its own try/catch so the
// component never crashes the bundle if the install hasn't happened yet.

let fontBlack:    any = null;
let fontSemiBold: any = null;
let fontItalic:   any = null;

try { fontBlack    = require('@expo-google-fonts/fraunces/Fraunces_900Black.ttf');         } catch { /* not installed */ }
try { fontSemiBold = require('@expo-google-fonts/fraunces/Fraunces_700Bold.ttf');          } catch { /* not installed */ }
try { fontItalic   = require('@expo-google-fonts/fraunces/Fraunces_900Black_Italic.ttf');  } catch { /* not installed */ }

// Module-level cache so the load only fires once across the whole app.
let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function loadFraunces(): Promise<void> {
  if (loaded) return;
  if (!fontBlack && !fontSemiBold && !fontItalic) return;       // package not installed
  if (loadingPromise) return loadingPromise;

  const families: Record<string, any> = {};
  if (fontBlack)    families['Fraunces-Black']        = fontBlack;
  if (fontSemiBold) families['Fraunces-Bold']         = fontSemiBold;
  if (fontItalic)   families['Fraunces-Black-Italic'] = fontItalic;

  loadingPromise = Font.loadAsync(families).then(() => { loaded = true; });
  return loadingPromise;
}

/**
 * Subscribers (each mounted DisplayText) get re-rendered when the font
 * finishes loading. We don't use Context — there's no useful prop to
 * pass — so a tiny pub/sub on a module-level Set does the job.
 */
const subscribers = new Set<() => void>();
function notify() { for (const s of subscribers) s(); }
loadingPromise?.then(notify);

// ── Component ─────────────────────────────────────────────────────────────

export type DisplayWeight = 'black' | 'bold';

interface DisplayTextProps extends TextProps {
  weight?:  DisplayWeight;
  italic?:  boolean;
  style?:   StyleProp<TextStyle>;
}

export function DisplayText({ weight = 'black', italic, style, ...rest }: DisplayTextProps) {
  const [, force] = useState(0);

  useEffect(() => {
    if (loaded) return;
    const cb = () => force(n => n + 1);
    subscribers.add(cb);
    void loadFraunces().then(notify);
    return () => { subscribers.delete(cb); };
  }, []);

  // Pick the best available variant:
  //   weight black + italic → Fraunces-Black-Italic if loaded, else system 900 italic
  //   weight black          → Fraunces-Black
  //   weight bold           → Fraunces-Bold
  const fontFamily = (() => {
    if (!loaded) return undefined;
    if (italic && weight === 'black')  return 'Fraunces-Black-Italic';
    if (weight === 'bold')             return 'Fraunces-Bold';
    return 'Fraunces-Black';
  })();

  // Fallback styling when the serif isn't loaded yet.
  const fallback: TextStyle = {
    fontWeight: weight === 'bold' ? '700' : '900',
    fontStyle:  italic ? 'italic' : 'normal',
    // Slightly tighter tracking compensates for system sans being wider
    // than Fraunces at the same point size.
    letterSpacing: -0.4,
  };

  return (
    <Text
      style={[
        fontFamily ? { fontFamily } : fallback,
        style,
      ]}
      {...rest}
    />
  );
}

export default DisplayText;
