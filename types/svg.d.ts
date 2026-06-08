// Treat imported .svg files as React components (provided by
// react-native-svg-transformer at build time).
declare module '*.svg' {
  import React from 'react';
  import { SvgProps } from 'react-native-svg';
  const content: React.FC<SvgProps>;
  export default content;
}
