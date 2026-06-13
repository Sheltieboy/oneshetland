/**
 * SplashVideo
 *
 * The waves background for the splash. Isolated in its own module so the
 * splash can load it defensively: builds that don't include the `expo-video`
 * native module (e.g. an older dev client) simply skip it and show the navy
 * splash instead of crashing. See SplashAnimation.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

const WAVES = require('../assets/waves-crashing.mp4');

export function SplashVideo() {
  const player = useVideoPlayer(WAVES, p => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  return (
    <VideoView
      style={StyleSheet.absoluteFill}
      player={player}
      contentFit="cover"
      nativeControls={false}
      pointerEvents="none"
    />
  );
}
