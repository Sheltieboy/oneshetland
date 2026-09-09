/**
 * Fingerprint inputs for the runtime version (app.json: runtimeVersion.policy = "fingerprint").
 *
 * Why this file exists. The runtime version decides which binary an OTA update
 * is allowed to install on. Under the old `appVersion` policy it was the string
 * "1.0.0", which never moved — so when expo-crypto (a native module) was added
 * after build #37, EAS still judged the new JS compatible with a binary that
 * had no ExpoCrypto in it. Fingerprinting replaces that hand-maintained string
 * with a hash of what actually goes into the binary.
 *
 * The one thing fingerprinting gets wrong for this repo is npm scripts. By
 * default every script is hashed except `android`/`ios`, and our `test` script
 * names ~110 test files: between build #37's commit and b744b1b5 it changed 119
 * times while nothing native moved once. Left alone, adding a test file would
 * mint a new runtime and silently orphan the installed build from every future
 * update — the same class of failure as before, just inverted.
 *
 * So all scripts are skipped, and only the scripts that CAN change native output
 * are hashed back in. Today that set is empty and this source hashes "{}". The
 * moment someone adds a postinstall, a patch-package step or an eas-build-*
 * hook, the runtime changes on its own and the split happens automatically
 * rather than depending on anyone remembering this file exists.
 */

const pkg = require('./package.json');

/**
 * Lifecycle and EAS Build hooks. These run during install or on the build
 * machine, so they can patch modules, generate config or touch the native
 * projects — a change to any of them can change the binary.
 */
const NATIVE_AFFECTING_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prebuild',
  'postbuild',
  'eas-build-pre-install',
  'eas-build-post-install',
  'eas-build-on-success',
  'eas-build-on-error',
  'eas-build-on-cancel',
];

const scripts = pkg.scripts ?? {};

module.exports = {
  // RNMapsDefines.h is written by a react-native-maps CocoaPods script phase on
  // every build: it caches whether the GoogleMaps pods are present, shipping as
  // 1 and being rewritten to 0 the first time a project without them builds.
  // Hashing it made the runtime change DURING the Xcode build, so the value
  // baked into the binary could never match the one an update was published
  // against. The condition it caches is driven by ios.config.googleMapsApiKey,
  // which is hashed inside expoConfig — so turning iOS Google Maps on still
  // moves the runtime. Only this one file is ignored; the rest of the module is
  // still hashed, so upgrading react-native-maps is still caught.
  ignorePaths: ['node_modules/react-native-maps/ios/AirMaps/RNMapsDefines.h'],
  sourceSkips: [
    // Drops `android`/`ios` when they are the stock `expo run:*` values. Already
    // the library default; named explicitly so the intent survives an upgrade.
    'PackageJsonAndroidAndIosScriptsIfNotContainRun',
    // Drops every remaining script — test lanes, typecheck, start/web.
    'PackageJsonScriptsAll',
    // Drops expo.version, ios.buildNumber and android.versionCode. A TestFlight
    // build number says nothing about native compatibility: without this, moving
    // to 38 for a local Xcode archive minted a different runtime, and build 39
    // would have minted another — orphaning every install from later updates.
    'ExpoConfigVersions',
  ],
  extraSources: [
    {
      type: 'contents',
      id: 'packageJson:nativeAffectingScripts',
      // Fixed key order, so re-ordering package.json cannot change the hash.
      contents: JSON.stringify(
        Object.fromEntries(
          NATIVE_AFFECTING_SCRIPTS
            .filter((key) => typeof scripts[key] === 'string')
            .map((key) => [key, scripts[key]]),
        ),
      ),
      reasons: ['packageJson:nativeAffectingScripts'],
    },
  ],
};
