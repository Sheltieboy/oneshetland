// accept-turnstile-stub.ts — ACCEPTANCE-TEST ONLY. The real sign-in asks the PRODUCTION website to run a Cloudflare Turnstile challenge, which a local backend
// can neither reach nor needs (the acceptance GoTrue has captcha switched off and ignores the token). accept-metro.sh points Metro's '@/lib/turnstile' at this
// file for the duration of an acceptance run ONLY, by patching metro.config.js in the working tree and restoring it afterwards: this stub is never part of a build.
export type TurnstileResult = { ok: true; token: string } | { ok: false; reason: string };
export const getTurnstileToken = async (): Promise<TurnstileResult> => ({ ok: true, token: 'acceptance-backend-ignores-this' });
