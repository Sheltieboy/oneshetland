# OneShetland — Payments & Payouts Test Plan (pre go-live)

Work through these **in Stripe TEST mode** first. Each story has: who/where, steps, what should happen, where to verify, and a box for your feedback. Once everything here passes, follow **§M Go-live switch** to move to live Stripe.

**Legend:** ⬜ Pass · ⬜ Fail · _Notes:_ ______

**Verify in two places every time:** (a) **Stripe Dashboard** (test mode) — Payments, Connect → connected accounts, Balance; (b) **Supabase** — the DB row/table named in the story.

---

## A. Pre-flight setup (do once before testing)

- [ ] **A1.** Confirm TEST keys are set in Supabase Edge Function secrets: `STRIPE_SECRET_KEY` (sk_test_…), `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, and web `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (pk_test_…).

- [ ] **A2.** Confirm test **Price IDs** in `admin_config` (or env): `STRIPE_PRICE_LOCAL_PRO`, `STRIPE_PRICE_LOCAL_PREMIUM`, `STRIPE_PRICE_ALERT_ADDON`. (If missing, subscriptions fail with a cryptic error — known gap.)

- [ ] **A3.** Stripe webhook endpoint points at `{SUPABASE_URL}/functions/v1/stripe-webhook` and is subscribed to: `payment_intent.succeeded`, `payment_intent.payment_failed`, `account.updated`, `customer.subscription.*`, `invoice.payment_succeeded`, `transfer.created`.

- [ ] **A4.** Have **3 test logins** ready: a **Customer**, a **Business owner**, a **Hub admin**, plus a **Driver** (Fetch). You'll onboard their payouts in §I.

**Stripe test cards:** success `4242 4242 4242 4242` · decline `4000 0000 0000 0002` · 3-D Secure/auth required `4000 0025 0000 3155`. Any future expiry, any CVC/postcode.

---

## B. Card on file (foundation for everything)

**B1 — Save a card** · Customer · app `payment-setup.tsx` (Local → Wallet/settings → add card)

1. Add `4242…`. 2. Save.

- ✅ Card saved; `profiles.stripe_customer_id` set; card shows as saved on return.

- ⬜ Pass ⬜ Fail — _Notes:_

**B2 — Declined card** · Customer · same screen, card `4000 0000 0000 0002`

- ✅ Clear decline message; no card saved; no crash.

- ⬜ Pass ⬜ Fail — _Notes:_

---

## C. Wallet (top-up = money IN, pay = payout to business)

**C1 — Top-up, new card (PaymentSheet)** · Customer · `local-wallet.tsx` → Top up £10 (`use_saved_card` off)

- ✅ PaymentSheet appears → pay → balance +£10. **No platform fee** (your own money in). DB: `local_wallet_transactions` type=`topup`; balance via `wallet_credit`. Stripe: PaymentIntent £10, metadata `type=local_wallet_topup`.

- ⬜ Pass ⬜ Fail — _Notes:_

**C2 — Top-up, saved card (off-session, no UI)** · Customer · Top up £20

- ✅ Charges saved card with no card form; balance +£20.

- ⬜ Pass ⬜ Fail — _Notes:_

**C3 — Pay in store with wallet → BUSINESS PAYOUT** · Customer · `local-pay.tsx` enter business code + amount (e.g. £10)

- ✅ Wallet −£10. Business receives a **Stripe transfer** to its connected account = £10 − platform commission (**2% + 25p** default) − business's own cashback%. DB: `local_wallet_transactions` debit; business credited. Stripe: Connect → business account shows the transfer; platform keeps the 2%+25p.

- ⚠️ This is the **main customer→business payout** — check the maths carefully.

- ⬜ Pass ⬜ Fail — _Notes:_

**C4 — Pay with insufficient balance** · Customer · pay more than balance

- ✅ Rejected cleanly; balance unchanged.

- ⬜ Pass ⬜ Fail — _Notes:_

**C5 — Pay a business that hasn't finished payout setup** · (use a business with `payout_enabled=false`)

- ✅ Blocked with "has not finished setting up payouts yet"; wallet **not** debited.

- ⬜ Pass ⬜ Fail — _Notes:_

---

## D. Event tickets (the 95p / commission flow → organiser payout)

**D1 — Buy tickets (saved card)** · Customer · `event-ticket-checkout.tsx` for an event with a paying organiser

1. Pick 2 tickets. 2. Enter attendee details. 3. Pay.

- ✅ Charged total; tickets become **valid**; capacity decremented (no oversell). DB: `event_ticket_orders` status=`paid`, `event_tickets` status=`valid`, event `tickets_sold` +2. Stripe: destination charge to **organiser's** Connect account; platform keeps commission. Push notification received.

- ⬜ Pass ⬜ Fail — _Notes:_

**D2 — Oversell guard** · two near-simultaneous buys of the last ticket(s)

- ✅ Only one succeeds; the other gets a clean "sold out". No negative capacity.

- ⬜ Pass ⬜ Fail — _Notes:_

**D3 — Buy tickets, card declined** · Customer · use `4000…0002`

- ✅ No tickets issued; capacity released (pending order not left blocking stock).

- ⬜ Pass ⬜ Fail — _Notes:_

---

## E. Hubs — membership, donation, Gift Aid (→ hub payout)

**E1 — Join paid membership** · Customer · `hub-membership-types.tsx` → Join a paid tier

- ✅ Charged **tier price + 95p platform fee** (fee added on top). Hub receives full tier price (destination charge). DB: `hub_members` row, `member_no`, `paid_until`. Stripe: Connect → hub account = tier price; platform keeps 95p.

- ⬜ Pass ⬜ Fail — _Notes:_

**E2 — Donate (no Gift Aid)** · Customer · `hub-donate.tsx` to an active campaign, £20

- ✅ Hub receives £20 (destination charge); platform takes ~Stripe cost only (no margin). DB: donation recorded.

- ⬜ Pass ⬜ Fail — _Notes:_

**E3 — Donate with "cover the fees"** · Customer · tick cover-fees, £20

- ✅ Customer pays £20 + fee estimate; **hub nets the full £20**.

- ⬜ Pass ⬜ Fail — _Notes:_

**E4 — Donate with Gift Aid (charity hub)** · Customer · full name + address + postcode, hub `is_charity` + charity number on file

- ✅ Gift Aid declaration stored; confirm returns `gift_aid: true`. DB: Gift Aid fields recorded against the donation.

- ⬜ Pass ⬜ Fail — _Notes:_

**E5 — Membership/donation on a hub NOT payout-ready**

- ✅ Blocked with "has not finished setting up payouts yet"; no charge.

- ⬜ Pass ⬜ Fail — _Notes:_

---

## F. Gifts & unit items (→ business payout)