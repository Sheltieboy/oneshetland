/**
 * apple-wallet.ts — download a signed .pkpass for a loyalty card from the
 * `apple-wallet-pass` edge function and hand it to the OS so the customer can
 * add it to Apple Wallet. iOS only (Android has no Wallet equivalent yet).
 */

import { Platform, Share } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase, SUPABASE_URL } from './supabase';

export const APPLE_WALLET_SUPPORTED = Platform.OS === 'ios';

export async function addLoyaltyCardToAppleWallet(cardId: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Please sign in first.');

  const url = `${SUPABASE_URL}/functions/v1/apple-wallet-pass?card_id=${encodeURIComponent(cardId)}`;
  const fileUri = `${FileSystem.cacheDirectory}oneshetland-${cardId}.pkpass`;
  const res = await FileSystem.downloadAsync(url, fileUri, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status !== 200) {
    let msg = 'Could not create your Wallet pass.';
    try {
      const body = await FileSystem.readAsStringAsync(fileUri);
      const j = JSON.parse(body);
      if (j?.error) msg = j.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }

  // The share sheet surfaces "Add to Apple Wallet" for a .pkpass file.
  await Share.share({ url: fileUri });
}
