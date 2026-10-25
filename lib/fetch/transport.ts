/**
 * lib/fetch/transport.ts — the app's transport for lib/fetch-api.ts (Fetch v2, Step 12).
 *
 * lib/fetch-api.ts, lib/fetch/present.ts and lib/fetch/flow.ts are byte-identical copies of the website's modules (a parity test holds
 * them together), so the app and the web speak one contract and one vocabulary. This file is the only app-specific part: it runs every
 * call with the signed-in member's own session through the shared Supabase client, so the database and the edge functions see who is
 * asking. It never writes a table; reads are limited to the three tables lib/fetch-api.ts names.
 */
import { supabase } from '@/lib/supabase';
import { FetchApi, type FetchTransport } from '@/lib/fetch-api';

/** A refusal from an edge function arrives as a non-2xx answer whose JSON body carries the stable code. */
export async function edgeErrorCode(error: unknown): Promise<string> {
  try {
    const ctx = (error as { context?: { json?: () => Promise<unknown> } })?.context;
    if (ctx && typeof ctx.json === 'function') {
      const body = (await ctx.json()) as { code?: unknown } | null;
      if (body && typeof body.code === 'string') return body.code;
    }
  } catch { /* keep the generic code */ }
  return 'server_error';
}

const transport: FetchTransport = {
  rpc: async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    return { data, error };
  },
  invoke: async (fn, body) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { data: null, error: { code: 'unauthorised' } };
    const { data, error } = await supabase.functions.invoke(fn, { headers: { Authorization: `Bearer ${session.access_token}` }, body });
    if (!error) return { data, error: null };
    return { data: null, error: { code: await edgeErrorCode(error) } };
  },
  read: async (table, columns, filter) => {
    let q = supabase.from(table).select(columns);
    if (filter) q = q.eq(filter.column, filter.value);
    const { data, error } = await q;
    return { data, error };
  },
};

/** The one Fetch v2 client the app uses. Screens call this; nothing else talks to Fetch. */
export const fetchApi = new FetchApi(transport);
