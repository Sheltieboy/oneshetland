/**
 * transcribe-audio
 *
 * Called by the client (memories-api.requestTranscription) after a voice
 * note is uploaded for a Memory. Pulls the audio out of the
 * memories-media bucket, hands it to OpenAI's Whisper transcription
 * endpoint, and writes the result back to memory_media.transcript /
 * .transcript_status.
 *
 * Body: { media_id: string }
 *
 * Env required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENAI_API_KEY                — for Whisper. If missing the function
 *                                   marks the row 'failed' but does NOT
 *                                   crash the upload path.
 *
 * Optional env:
 *   WHISPER_MODEL                 — default 'whisper-1'
 *   WHISPER_PROMPT                — pre-seeded prompt to bias the model
 *                                   toward Shetlandic vocabulary. If unset
 *                                   we default to a Shetland-friendly
 *                                   primer.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DEFAULT_WHISPER_PROMPT =
  'This is a voice memo from a Shetland islander. Place and dialect words ' +
  'may include: Lerwick, Brae, Hillswick, Cullivoe, Hamnavoe, Sandwick, ' +
  'Yell, Unst, Fetlar, Whalsay, Foula, Fair Isle, voe, geo, peerie, peat, ' +
  'da, dat, croft, hairst, simmer, vaar.';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl     = Deno.env.get('SUPABASE_URL')              ?? '';
  const serviceRoleKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const openAiKey       = Deno.env.get('OPENAI_API_KEY')            ?? '';
  const whisperModel    = Deno.env.get('WHISPER_MODEL')             ?? 'whisper-1';
  const whisperPrompt   = Deno.env.get('WHISPER_PROMPT')            ?? DEFAULT_WHISPER_PROMPT;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let mediaId: string | undefined;
  try {
    const body = await req.json();
    mediaId = body?.media_id;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!mediaId) {
    return new Response(JSON.stringify({ error: 'media_id required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── Look up the media row ─────────────────────────────────────────────────
  const { data: media, error: mErr } = await supabase
    .from('memory_media')
    .select('id, kind, storage_path, transcript_status')
    .eq('id', mediaId)
    .maybeSingle();

  if (mErr || !media) {
    return new Response(JSON.stringify({ error: 'Media not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (media.kind !== 'audio') {
    return new Response(JSON.stringify({ error: 'Not an audio media' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (media.transcript_status === 'done') {
    return new Response(JSON.stringify({ ok: true, alreadyDone: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── If we don't have Whisper credentials, mark failed and bail ────────────
  if (!openAiKey) {
    await supabase
      .from('memory_media')
      .update({ transcript_status: 'failed' })
      .eq('id', mediaId);
    return new Response(JSON.stringify({
      ok: false,
      error: 'OPENAI_API_KEY not configured — transcription skipped',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── Download the audio from storage ──────────────────────────────────────
  const { data: fileBlob, error: dlErr } = await supabase.storage
    .from('memories-media')
    .download(media.storage_path);

  if (dlErr || !fileBlob) {
    await supabase
      .from('memory_media')
      .update({ transcript_status: 'failed' })
      .eq('id', mediaId);
    return new Response(JSON.stringify({ error: 'Could not load audio' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── Whisper call ──────────────────────────────────────────────────────────
  try {
    const form = new FormData();
    form.append('file', fileBlob, media.storage_path.split('/').pop() ?? 'audio.m4a');
    form.append('model', whisperModel);
    form.append('prompt', whisperPrompt);
    form.append('response_format', 'json');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiKey}` },
      body: form,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      await supabase
        .from('memory_media')
        .update({ transcript_status: 'failed' })
        .eq('id', mediaId);
      return new Response(JSON.stringify({
        error: 'Whisper API error',
        detail: errText.slice(0, 500),
      }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const json = await whisperRes.json();
    const transcript = (json?.text ?? '').trim();

    await supabase
      .from('memory_media')
      .update({
        transcript,
        transcript_status: transcript ? 'done' : 'failed',
      })
      .eq('id', mediaId);

    return new Response(JSON.stringify({ ok: true, transcript }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    await supabase
      .from('memory_media')
      .update({ transcript_status: 'failed' })
      .eq('id', mediaId);
    return new Response(JSON.stringify({
      error: 'Transcription threw',
      detail: (err as Error).message,
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
