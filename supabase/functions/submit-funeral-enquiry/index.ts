import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleFuneralEnquiry } from '../_shared/funeral-enquiry.ts';

/**
 * submit-funeral-enquiry — the ONLY way an anonymous visitor can send a "Contact us about this announcement" enquiry.
 * All behaviour lives in _shared/funeral-enquiry.ts (so it is tested locally with a mocked Cloudflare); this file only supplies the Deno environment.
 *
 * Secrets / settings required (the function refuses every request, 503, until ALL are set):
 *   TURNSTILE_SECRET_KEY              the Turnstile widget's secret (never sent to a browser)
 *   TURNSTILE_ALLOWED_HOSTNAMES       comma list, e.g. oneshetland.com,www.oneshetland.com
 *   FUNERAL_ENQUIRY_ALLOWED_ORIGINS   comma list, e.g. https://oneshetland.com,https://www.oneshetland.com
 *   FUNERAL_ENQUIRY_IP_SALT           long random string; keys the hash of the client address
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by Supabase
 * Deploy with JWT verification OFF (visitors are signed out; Turnstile + the limiter are the boundary): config.toml sets verify_jwt = false.
 */
serve((req) => handleFuneralEnquiry(req, { env: (k) => Deno.env.get(k), fetch }));
