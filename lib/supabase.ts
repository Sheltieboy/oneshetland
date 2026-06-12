import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Encrypted session storage.
 *
 * The Supabase auth session (JWT + refresh token) was previously persisted in
 * AsyncStorage, which is plaintext on disk and readable on rooted/jailbroken
 * devices or via backups. We now store it in the OS keychain/keystore via
 * expo-secure-store.
 *
 * SecureStore has a ~2KB per-value limit and Supabase sessions can exceed that,
 * so this adapter transparently splits large values into numbered chunks and
 * records the count in the primary key as "__chunks__:N".
 *
 * On web (where SecureStore is unavailable) we fall back to AsyncStorage.
 *
 * NOTE: on the first build that ships this change, existing users' sessions
 * live in AsyncStorage and won't be found here — they'll simply be asked to
 * sign in once more. That is expected and harmless.
 */
const CHUNK_SIZE = 1800; // comfortably under SecureStore's limit
const sanitize = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

async function clearChunks(k: string): Promise<void> {
  const head = await SecureStore.getItemAsync(k);
  const m = head?.match(/^__chunks__:(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${k}.${i}`);
  }
}

const SecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const k = sanitize(key);
    const head = await SecureStore.getItemAsync(k);
    if (head == null) return null;
    const m = head.match(/^__chunks__:(\d+)$/);
    if (!m) return head;
    const n = parseInt(m[1], 10);
    let out = '';
    for (let i = 0; i < n; i++) {
      const part = await SecureStore.getItemAsync(`${k}.${i}`);
      if (part == null) return null; // a chunk is missing → treat as no session
      out += part;
    }
    return out;
  },
  async setItem(key: string, value: string): Promise<void> {
    const k = sanitize(key);
    await clearChunks(k); // remove any stale chunks from a previous, larger value
    if (value.length <= CHUNK_SIZE) {
      await SecureStore.setItemAsync(k, value);
      return;
    }
    const n = Math.ceil(value.length / CHUNK_SIZE);
    for (let i = 0; i < n; i++) {
      await SecureStore.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    await SecureStore.setItemAsync(k, `__chunks__:${n}`);
  },
  async removeItem(key: string): Promise<void> {
    const k = sanitize(key);
    await clearChunks(k);
    await SecureStore.deleteItemAsync(k);
  },
};

// SecureStore is native-only; AsyncStorage is the web fallback.
const authStorage = Platform.OS === 'web' ? AsyncStorage : SecureStoreAdapter;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    '\n[OneShetland Fetch] ⚠️  Supabase is not configured.\n' +
      'Copy .env.example to .env and add your Supabase URL and anon key.\n' +
      'See README.md for full setup instructions.\n',
  );
}

export const supabase = createClient(
  supabaseUrl ?? 'https://placeholder.supabase.co',
  supabaseAnonKey ?? 'placeholder-anon-key',
  {
    auth: {
      storage: authStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);

export const isSupabaseConfigured =
  Boolean(supabaseUrl) &&
  Boolean(supabaseAnonKey) &&
  supabaseUrl !== 'https://placeholder.supabase.co';

/**
 * Bare Supabase project URL — exported so helpers that need to hit the
 * storage REST endpoint directly (e.g. React Native FormData uploads,
 * where the JS SDK's blob path uploads 0-byte files on iOS) can compose
 * URLs without re-reading the env var.
 */
export const SUPABASE_URL = supabaseUrl ?? 'https://placeholder.supabase.co';
export const SUPABASE_ANON_KEY = supabaseAnonKey ?? '';
