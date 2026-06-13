import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * ai-cover-letter
 *
 * Drafts a short, tailored cover note from the signed-in user's worker profile
 * + the target job. Uses Claude when ANTHROPIC_API_KEY is set; otherwise falls
 * back to a sensible template so the feature always returns something usable.
 *
 * Body: { job_id }  →  { cover_letter }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const auth = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return json({ error: 'Not signed in' }, 401);

    const { job_id } = await req.json();
    if (!job_id) return json({ error: 'job_id required' }, 400);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const [{ data: job }, { data: wp }, { data: prof }] = await Promise.all([
      svc.from('jobs').select('title, description, category, location, locality, posted_as_business_id, business:local_businesses(name)').eq('id', job_id).maybeSingle(),
      svc.from('worker_profiles').select('headline, summary, skills, qualifications, experience').eq('user_id', user.id).maybeSingle(),
      svc.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    ]);
    if (!job) return json({ error: 'Job not found' }, 404);

    const employer = (job as any).business?.name ?? 'your team';
    const name     = (prof as any)?.full_name ?? '';
    const skills   = Array.isArray((wp as any)?.skills) ? (wp as any).skills.join(', ') : '';
    const quals    = Array.isArray((wp as any)?.qualifications) ? (wp as any).qualifications.join(', ') : '';

    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (key) {
      const prompt =
        `Write a concise, warm, professional cover note (max ~150 words, first person, no placeholders, ` +
        `British English) for a job application. Do not invent qualifications or experience beyond what's given. ` +
        `Return ONLY the letter body — no subject line, no "Dear..." salutation, no sign-off name.\n\n` +
        `Applicant: ${name || 'the candidate'}\n` +
        `Headline: ${(wp as any)?.headline ?? ''}\n` +
        `About them: ${(wp as any)?.summary ?? ''}\n` +
        `Skills: ${skills}\n` +
        `Qualifications: ${quals}\n\n` +
        `Role: ${job.title} at ${employer}${job.locality ? `, ${job.locality}` : ''}\n` +
        `Role description: ${(job.description ?? '').slice(0, 1200)}`;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await res.json();
        const text = data?.content?.[0]?.text?.trim();
        if (text) return json({ cover_letter: text });
      } catch { /* fall through to template */ }
    }

    // Fallback template — usable even with no AI key configured.
    const bits = [
      `I'd love to be considered for the ${job.title} role${employer !== 'your team' ? ` at ${employer}` : ''}.`,
      (wp as any)?.summary ? String((wp as any).summary).trim() : '',
      skills ? `My main strengths are ${skills}.` : '',
      quals ? `I hold ${quals}.` : '',
      `I'm based in Shetland and keen to bring my experience to your team. I'd welcome the chance to chat.`,
    ].filter(Boolean);
    return json({ cover_letter: bits.join('\n\n') });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
