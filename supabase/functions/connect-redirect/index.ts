import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

/**
 * connect-redirect
 *
 * Acts as an HTTPS landing page for Stripe Connect onboarding return/refresh URLs.
 * Stripe requires HTTPS URLs — this page immediately redirects into the app via deep link.
 *
 * Routes:
 *   ?business=xxx          → local business onboarding return
 *   ?retry=1&business=xxx  → local business onboarding refresh (retry)
 *   ?status=refresh        → driver refresh (legacy)
 *   (default)              → driver return (legacy)
 */
serve((req) => {
  const url = new URL(req.url);
  const businessId = url.searchParams.get('business');
  const hubId      = url.searchParams.get('hub');
  const retry      = url.searchParams.get('retry');
  const status     = url.searchParams.get('status') ?? 'return';

  let appScheme: string;
  if (hubId) {
    appScheme = `oneshetland-fetch://hub-membership-types?id=${hubId}&connect=${retry ? 'refresh' : 'return'}`;
  } else if (businessId) {
    appScheme = retry
      ? `oneshetland-fetch://local-business-dashboard?connect=refresh&business=${businessId}`
      : `oneshetland-fetch://local-business-dashboard?connect=return&business=${businessId}`;
  } else {
    appScheme = status === 'refresh'
      ? 'oneshetland-fetch://driver/connect-refresh'
      : 'oneshetland-fetch://driver/connect-return';
  }

  return new Response(null, {
    status: 302,
    headers: { 'Location': appScheme },
  });
});
