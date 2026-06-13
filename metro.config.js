const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// ── SVG → React component (react-native-svg-transformer) ────────────────────
// .svg imports return a component you can render directly. Used by the Map It
// game to render the Shetland blank-map asset without pulling in a heavy map
// library.
config.transformer.babelTransformerPath = require.resolve('react-native-svg-transformer/expo');
config.resolver.assetExts = config.resolver.assetExts.filter(ext => ext !== 'svg');
config.resolver.sourceExts = [...config.resolver.sourceExts, 'svg'];

// Make sure bundled video files resolve as assets.
for (const ext of ['mp4', 'mov']) {
  if (!config.resolver.assetExts.includes(ext)) config.resolver.assetExts.push(ext);
}

// ── Force @supabase/supabase-js to its CJS build ───────────────────────────
// The .mjs build uses dynamic import() which Hermes rejects as invalid syntax.
// All other packages keep normal resolution (including package exports).
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@supabase/supabase-js') {
    return {
      filePath: path.resolve(
        __dirname,
        'node_modules/@supabase/supabase-js/dist/index.cjs'
      ),
      type: 'sourceFile',
    };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
