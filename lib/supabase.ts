import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

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
      storage: AsyncStorage,
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
