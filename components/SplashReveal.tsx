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
const CREAM = '#F4EDDF'; // the field the reveal is painted on — matches SplashAnimation

export function SplashReveal({ onEnd }: { onEnd: () => void }) {
  const [ended, setEnded] = useState(false);
  const firedRef = useRef(false);

  const player = useVideoPlayer(REVEAL, (p) => {
    p.loop = false;
    p.muted = true;
    // Don't seize the iOS audio session on launch — otherwise this decorative,
    // muted splash video stops whatever music/video the user had playing.
    p.audioMixingMode = 'mixWithOthers';
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
    // Cream field behind the video so there's no black flash before its first
    // frame renders (the reveal is painted on cream).
    <View style={[StyleSheet.absoluteFill, { backgroundColor: CREAM }]}>
      <VideoView
        style={[StyleSheet.absoluteFill, { backgroundColor: CREAM }]}
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
