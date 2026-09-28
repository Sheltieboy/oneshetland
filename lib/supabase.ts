import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import { createChunkedSecureStorage } from './secure-store-adapter';

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
 * so the adapter (lib/secure-store-adapter.ts) transparently splits large values
 * into numbered chunks.
 *
 * On web (where SecureStore is unavailable) we fall back to AsyncStorage.
 *
 * NOTE: on the first build that ships this change, existing users' sessions
 * live in AsyncStorage and won't be found here — they'll simply be asked to
 * sign in once more. That is expected and harmless.
 */
const SecureStoreAdapter = createChunkedSecureStorage(SecureStore);

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
