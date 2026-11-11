// host.ts: runs ONE real Editions edge function locally WITHOUT editing its source.
//   FUNCTION=<dir name under supabase/functions>  FUNCTION_PORT=<port>  STRIPE_FORWARDER_URL=http://127.0.0.1:<port>
// 1. globalThis.fetch is wrapped: requests to the hard-coded https://api.stripe.com origin are rewritten to the local forwarder; requests to 127.0.0.1 pass; EVERYTHING ELSE is refused
//    (defence in depth on top of --allow-net=127.0.0.1).
// 2. std@0.168 `serve()` listens on port 8000 by default: Deno.listen is wrapped so it binds FUNCTION_PORT on 127.0.0.1 only.
// 3. the function module is imported dynamically (it calls serve() at import time).
const FN = Deno.env.get('FUNCTION') ?? '';
const PORT = Number(Deno.env.get('FUNCTION_PORT') ?? '0');
const FWD = (Deno.env.get('STRIPE_FORWARDER_URL') ?? '').replace(/\/$/, '');
if (!['create-edition-checkout', 'editions-stripe-webhook', 'editions-commerce-cron'].includes(FN)) throw new Error(`FUNCTION not allowed: ${FN}`);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(FWD)) throw new Error('STRIPE_FORWARDER_URL must be http://127.0.0.1:<port>');
if (!(PORT > 1023)) throw new Error('FUNCTION_PORT invalid');
const STRIPE_ORIGIN = 'https://api.stripe.com';
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${STRIPE_ORIGIN}/`)) {
    const to = FWD + url.slice(STRIPE_ORIGIN.length);
    return realFetch(typeof input === 'string' || input instanceof URL ? to : new Request(to, input), init);
  }
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input as RequestInfo, init);
  return Promise.reject(new Error(`blocked outbound request to ${new URL(url).origin} (local runner allows only 127.0.0.1 and the Stripe forwarder)`));
}) as typeof fetch;
const realListen = Deno.listen.bind(Deno);
(Deno as unknown as { listen: unknown }).listen = (o: Deno.ListenOptions) => realListen({ ...o, port: PORT, hostname: '127.0.0.1' });
await import(new URL(`../../../supabase/functions/${FN}/index.ts`, import.meta.url).href);
console.log(`[host] ${FN} listening on 127.0.0.1:${PORT}; api.stripe.com -> ${FWD}`);
