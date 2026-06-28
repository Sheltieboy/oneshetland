/**
 * Dynamic Expo config, layered on top of app.json.
 *
 * Why this exists: react-native-maps on Android requires a Google Maps API key
 * as `com.google.android.geo.API_KEY` meta-data in AndroidManifest.xml. Without
 * it, ANY <MapView> crashes the app at native view-mount ("API key not found").
 * iOS is unaffected (react-native-maps uses Apple Maps there by default).
 *
 * We inject the key from an env var (kept out of git via .env / EAS env) rather
 * than hard-coding it into app.json. Prefer a dedicated maps key if present,
 * otherwise fall back to the existing Google key (which must have
 * "Maps SDK for Android" enabled in the Google Cloud console).
 */
module.exports = ({ config }) => {
  const mapsKey =
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY;

  return {
    ...config,
    android: {
      ...config.android,
      config: {
        ...(config.android?.config ?? {}),
        ...(mapsKey ? { googleMaps: { apiKey: mapsKey } } : {}),
      },
    },
  };
};
