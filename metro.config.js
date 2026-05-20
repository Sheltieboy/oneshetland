const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js exports both a .mjs (uses dynamic import() which
// Hermes rejects) and a .cjs (uses safe require()). Metro was picking the
// .mjs via the package exports "import" condition. Map it to .cjs directly.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@supabase/supabase-js': path.resolve(
    __dirname,
    'node_modules/@supabase/supabase-js/dist/index.cjs'
  ),
};

// Disable package exports resolution so packages fall back to their
// "main" field (CommonJS) instead of the "import" condition (.mjs)
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
