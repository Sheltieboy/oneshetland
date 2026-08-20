import { supabase } from '@/lib/supabase';

/**
 * peerie-auth.ts — the app's credential for the website's AI routes.
 *
 * WHY THIS EXISTS
 *
 * Peerie Bot's parsing and day-planning live on the website, because the
 * ANTHROPIC_API_KEY has to stay server-side and the prompts are tuned there.
 * The app posted to those routes with nothing but a Content-Type header.
 *
 * That was fine while the routes were open to anyone, which was the problem:
 * six of the eight could be called by any stranger on the internet and spend
 * the OneShetland Anthropic key. Now they require a signed-in user and count
 * usage against them.
 *
 * The browser sends a session cookie. The app is cross-origin and has no
 * cookies at all, so it sends the same Supabase session as a Bearer token —
 * the pattern already used for wallet passes, memories, events and boats.
 * Without this the app would get a 401 from every AI feature.
 */
export async function peerieHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // No session → no header. The server answers 401, which is the honest
  // outcome: Peerie Bot is a signed-in feature now.
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  return headers;
}
