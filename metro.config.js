const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Force transpilation of packages that ship modern JS syntax
// that Hermes cannot handle without Babel transformation
config.transformer = {
  ...config.transformer,
  getTransformOptions: async () => ({
    transform: {
      experimentalImportSupport: false,
      inlineRequires: true,
    },
  }),
};

// Ensure packages using ES modules / private class fields get transpiled
const defaultBlockList = config.resolver?.blockList ?? [];
config.resolver = {
  ...config.resolver,
  unstable_enablePackageExports: true,
};

module.exports = config;
