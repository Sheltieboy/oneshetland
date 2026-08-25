import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
/**
 * Would this payment pay its own payer?
 *
 * Asked of the DESTINATION ACCOUNT, not of the hub or business being paid: a
 * connected account can be attached to more than one resource — production
 * already has two hubs sharing one, and nothing enforces uniqueness — so
 * "do they own this hub?" would miss a payment routed through a sibling.
 *
 * Call it BEFORE claiming the attempt and before the debit, so a refusal costs
 * nothing and the same reference can be used again for a legitimate recipient.
 *
 * Not for platform-revenue checkouts. A shift boost has no destination at all,
 * so there is nothing here to ask about.
 *
 * Used by wallet spends AND by the card membership charge — a destination
 * charge pays a connected account just as surely as a wallet transfer does,
 * and the payer should not be on the receiving end of either.
 */
export async function selfPaymentBlock(
  svc: SupabaseClient,
  userId: string,
  destinationAccount: string | null | undefined,
): Promise<{ body: { error: string; reason: string }; status: number } | null> {
  if (!destinationAccount) return null;
  const { data, error } = await svc.rpc('wallet_destination_self_controlled', {
    p_user: userId, p_account: destinationAccount,
  });
  if (error) throw error;
  if (!data) return null;
  return {
    status: 403,
    body: {
      error: "You can't use your OneShetland wallet to pay a business or hub you control.",
      reason: 'self_payment',
    },
  };
}
