-- Charge-by-scan: a business scans the customer's ONE member card and requests a
-- wallet payment; the customer approves it on their own phone before any money
-- moves. This table is the pending request the two sides hand off through.
--
-- Consent is the whole point: unlike a stamp (which only GIVES the customer
-- something), a charge moves money, so the customer must approve. The business
-- never charges silently — it can only ask.
--
-- Execution (debit + Stripe transfer) runs in the wallet-charge-approve edge
-- function via the service role; regular users can only READ their own rows
-- (for the realtime approval prompt / the till's status poll). No client
-- INSERT/UPDATE — the edge functions own every state change.

CREATE TABLE public.wallet_charge_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  requested_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_pence      integer NOT NULL CHECK (amount_pence >= 50),
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','charging','paid','declined','expired','failed')),
  stripe_transfer_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  resolved_at       timestamptz
);

-- Customer's pending-request lookups + the till's status poll.
CREATE INDEX wallet_charge_requests_customer_idx ON public.wallet_charge_requests (customer_id, status);
CREATE INDEX wallet_charge_requests_business_idx ON public.wallet_charge_requests (business_id, created_at DESC);

ALTER TABLE public.wallet_charge_requests ENABLE ROW LEVEL SECURITY;

-- The customer sees requests aimed at them (to approve/decline).
CREATE POLICY "customer reads own charge requests"
  ON public.wallet_charge_requests FOR SELECT
  USING (customer_id = auth.uid());

-- The business owner sees requests raised by their business (to watch the status).
CREATE POLICY "business owner reads their charge requests"
  ON public.wallet_charge_requests FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.local_businesses b
    WHERE b.id = wallet_charge_requests.business_id AND b.owner_id = auth.uid()
  ));

-- No INSERT/UPDATE/DELETE policies: only the service role (edge functions) writes.

GRANT SELECT ON public.wallet_charge_requests TO authenticated;

-- Realtime so the customer's phone sees a new request instantly and the till
-- sees the approve/decline instantly. RLS above still gates every row.
ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_charge_requests;
