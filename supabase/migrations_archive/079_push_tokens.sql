-- 079_push_tokens.sql
-- Adds the push_token column to profiles (was previously missing from all
-- migrations even though the notify-* functions and send-push helper read it).

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS push_token TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_push_token
  ON public.profiles(push_token)
  WHERE push_token IS NOT NULL;
