/**
 * secure-store-adapter.ts — the chunked session storage lib/supabase.ts hands
 * to supabase-js, lifted out unchanged so it can be exercised under node with a
 * fake keychain. No React Native imports.
 *
 * SecureStore has a ~2KB per-value limit and Supabase sessions can exceed that,
 * so large values are split into numbered chunks with the count recorded in the
 * primary key as "__chunks__:N".
 *
 * A key that was never written — a brand-new install — reads as `null`, which
 * supabase-js treats as "no session". That is the normal first-launch state.
 */

export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const CHUNK_SIZE = 1800; // comfortably under SecureStore's limit
const sanitize = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export function createChunkedSecureStorage(store: KeyValueStore) {
  async function clearChunks(k: string): Promise<void> {
    const head = await store.getItemAsync(k);
    const m = head?.match(/^__chunks__:(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      for (let i = 0; i < n; i++) await store.deleteItemAsync(`${k}.${i}`);
    }
  }

  return {
    async getItem(key: string): Promise<string | null> {
      const k = sanitize(key);
      const head = await store.getItemAsync(k);
      if (head == null) return null;
      const m = head.match(/^__chunks__:(\d+)$/);
      if (!m) return head;
      const n = parseInt(m[1], 10);
      let out = '';
      for (let i = 0; i < n; i++) {
        const part = await store.getItemAsync(`${k}.${i}`);
        if (part == null) return null; // a chunk is missing → treat as no session
        out += part;
      }
      return out;
    },
    async setItem(key: string, value: string): Promise<void> {
      const k = sanitize(key);
      await clearChunks(k); // remove any stale chunks from a previous, larger value
      if (value.length <= CHUNK_SIZE) {
        await store.setItemAsync(k, value);
        return;
      }
      const n = Math.ceil(value.length / CHUNK_SIZE);
      for (let i = 0; i < n; i++) {
        await store.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
      }
      await store.setItemAsync(k, `__chunks__:${n}`);
    },
    async removeItem(key: string): Promise<void> {
      const k = sanitize(key);
      await clearChunks(k);
      await store.deleteItemAsync(k);
    },
  };
}
