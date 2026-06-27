-- ============================================================================
-- SECURITY FIX: wallet_credit / wallet_debit were SECURITY DEFINER and granted
-- EXECUTE to anon + authenticated. They take an arbitrary (p_user, amount), so
-- any signed-in (or even anonymous) client could call wallet_credit to mint
-- balance for any user, or wallet_debit to drain another user's balance.
--
-- Verified that NO client code calls these directly — only edge functions do,
-- via the service_role key. So we revoke public access and keep service_role.
-- ============================================================================

revoke all on function public.wallet_credit(p_user uuid, p_amount integer) from anon, authenticated;
revoke all on function public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer) from anon, authenticated;

-- service_role retains EXECUTE (edge functions rely on it):
grant execute on function public.wallet_credit(p_user uuid, p_amount integer) to service_role;
grant execute on function public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer) to service_role;
