import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

/**
 * connect-redirect
 *
 * Acts as an HTTPS landing page for Stripe Connect onboarding return/refresh URLs.
 * Stripe requires HTTPS URLs — this page immediately redirects into the app via deep link.
 */
serve((req) => {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'return';

  const appScheme = status === 'refresh'
    ? 'oneshetland-fetch://driver/connect-refresh'
    : 'oneshetland-fetch://driver/connect-return';

  return new Response(null, {
    status: 302,
    headers: { 'Location': appScheme },
  });
});
