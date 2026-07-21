/**
 * google-wallet.ts — fetch a "Save to Google Wallet" link for a loyalty card
 * from the google-wallet-pass edge function and open it. Android only (Google
 * Wallet's home turf; iOS uses Apple Wallet).
 */

import { Platform, Linking } from 'react-native';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

export const GOOGLE_WALLET_SUPPORTED = Platform.OS === 'android';

export async function addToGoogleWallet(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Please sign in first.');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/google-wallet-pass`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.saveUrl) throw new Error(body?.error ?? 'Could not create your Wallet pass.');
  await Linking.openURL(body.saveUrl as string);
}
