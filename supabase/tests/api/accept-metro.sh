#!/bin/bash
# accept-metro.sh start|stop — Metro for the Android emulator against the ACCEPTANCE backend (accept-env.sh). It temporarily patches metro.config.js so that
# '@/lib/turnstile' resolves to accept-turnstile-stub.ts (see that file), and `stop` restores the file with git. Nothing here is committed or shipped.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [ "${1:-}" = "stop" ]; then pkill -f "expo start" 2>/dev/null || true; git checkout -- metro.config.js; echo "metro.config.js restored"; exit 0; fi
python3 - <<'PY'
p = 'metro.config.js'; s = open(p).read()
if 'accept-turnstile-stub' not in s:
    s = s.replace("module.exports = config;", """// ACCEPTANCE ONLY (accept-metro.sh) - restored by `git checkout`.
const _prev = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => moduleName === '@/lib/turnstile'
  ? { filePath: path.resolve(__dirname, 'supabase/tests/api/accept-turnstile-stub.ts'), type: 'sourceFile' } : _prev(context, moduleName, platform);
module.exports = config;""")
    open(p, 'w').write(s)
PY
ANON="$(cat /tmp/accept-anon.txt)"
adb reverse tcp:54800 tcp:54800 >/dev/null; adb reverse tcp:8082 tcp:8082 >/dev/null
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54800 EXPO_PUBLIC_SUPABASE_ANON_KEY="$ANON" nohup npx expo start --dev-client --port 8082 --clear > /tmp/metro.log 2>&1 &
echo "metro starting (log /tmp/metro.log)"
