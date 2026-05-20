const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Force Babel transformation for packages that ship modern JS syntax
// (private class fields, optional chaining, etc.) that Hermes cannot handle raw
config.transformer.minifierConfig = {};
config.resolver.sourceExts = [...config.resolver.sourceExts];

// Override transformIgnorePatterns to include packages that need transpiling
config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(expo|@expo|expo-router|expo-modules-core|expo-constants|expo-linking|expo-notifications|expo-device|expo-secure-store|expo-splash-screen|expo-status-bar|expo-font|expo-web-browser|react-native|@react-native|@react-native-community|@stripe/stripe-react-native|@supabase|react-native-url-polyfill|react-native-safe-area-context|react-native-screens)/)',
];

module.exports = config;
