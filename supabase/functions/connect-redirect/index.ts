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

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0;url=${appScheme}">
    <title>Returning to OneShetland Fetch…</title>
    <style>
      body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
             justify-content: center; height: 100vh; margin: 0; background: #0F2240; color: white; }
      p { font-size: 18px; text-align: center; }
      a { color: #12B3D6; }
    </style>
  </head>
  <body>
    <p>Returning to the app…<br><br>
      <a href="${appScheme}">Tap here if it doesn't open automatically</a>
    </p>
    <script>window.location.href = "${appScheme}";</script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
});
