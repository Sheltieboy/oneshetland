/**
 * SplashReveal
 *
 * The animated brand reveal (rings weave on, then resolve into the painterly
 * OneShetland mark) played as the cold-launch splash. Isolated in its own module
 * so SplashAnimation can load it defensively — builds without the `expo-video`
 * native module fall back to the animated RingLoader instead of crashing.
 *
 * Plays once on a cream field (matching the video), then holds on the resolved
 * logo poster so the last frame is stable while we wait for auth to load.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Image } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

const REVEAL = require('../assets/splash-reveal.mp4');
const POSTER = require('../assets/splash-reveal-poster.png');

export function SplashReveal({ onEnd }: { onEnd: () => void }) {
  const [ended, setEnded] = useState(false);
  const firedRef = useRef(false);

  const player = useVideoPlayer(REVEAL, (p) => {
    p.loop = false;
    p.muted = true;
    p.play();
  });

  useEffect(() => {
    const finish = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      setEnded(true);
      onEnd();
    };
    const sub = player.addListener('playToEnd', finish);
    // Safety net: if the end event never fires, finish a touch after the cut length.
    const t = setTimeout(finish, 3600);
    return () => {
      sub.remove();
      clearTimeout(t);
    };
  }, [player, onEnd]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
      {/* Stable resolved-logo frame once the reveal finishes */}
      {ended && (
        <Image
          source={POSTER}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      )}
    </View>
  );
}
