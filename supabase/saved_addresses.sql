-- Run this in the Supabase SQL editor to enable saved addresses.

CREATE TABLE IF NOT EXISTS public.saved_addresses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  address    TEXT NOT NULL,
  postcode   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast per-user lookups
CREATE INDEX IF NOT EXISTS saved_addresses_user_id_idx ON public.saved_addresses(user_id);

-- RLS
ALTER TABLE public.saved_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own saved addresses"
  ON public.saved_addresses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own saved addresses"
  ON public.saved_addresses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saved addresses"
  ON public.saved_addresses FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can read all saved addresses"
  ON public.saved_addresses FOR SELECT
  USING (get_my_role() = 'admin');
