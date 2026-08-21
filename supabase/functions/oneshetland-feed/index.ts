import { safeError } from '../_shared/safe-error.ts';
/**
 * oneshetland-feed
 *
 * Proxies the WordPress home-feed endpoint server-side so the mobile
 * app never hits Cloudflare directly (bypasses bot detection / caching).
 */

const WP_FEED = 'https://oneshetland.com/wp-json/oneshetland/v1/home-feed';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const res = await fetch(WP_FEED, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; OneShetlandApp/1.0)',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WordPress returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '');
      throw new Error(`Unexpected content-type: ${contentType} — ${text.slice(0, 200)}`);
    }

    const data = await res.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[oneshetland-feed]', err);
    return new Response(
      JSON.stringify({ error: safeError('oneshetland-feed', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
