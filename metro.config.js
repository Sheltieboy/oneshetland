const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Use a custom resolver to force @supabase/supabase-js to its CJS build.
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
