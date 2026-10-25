# Seven legacy Fetch suites — disposition (Step 13)

These are the v1 Fetch payment-rail suites. They probed production with throwaway rows (service key or `supabase db query --linked`) and tested v1 code: `authorise-payment`, `capture-payment`, `fetch-quote`, `fetch_mark_collected`, client `delivery_requests` writes, `estimateFee` and the web `RequestComposer`/`DriverActions`. Each one is removed with `git rm` (git history keeps it). Every guarantee it carried is marked as one of:

- **proven:** already proved for Fetch v2 by an isolated suite;
- **ported:** newly proved in `fetch-v2-legacy-guarantees`, an isolated suite;
- **retired:** v1-only, or not Fetch-specific.

Key to the suite names below:

| Short name | Suite |
|---|---|
| L | `fetch-v2-lifecycle` |
| P | `fetch-v2-payments` |
| PT | `fetch-v2-pricing-terms` |
| AB | `fetch-v2-access-boundary` |
| LG | `fetch-v2-legacy-guarantees` (new) |
| AJ | `fetch-v2-scenarios` (new) |

## fetch-price-authority (24 guarantees): 15 proven, 3 ported, 6 retired

| Guarantee | Disposition |
|---|---|
| A price sent with the request is discarded | **proven:** PT "no client financial or state override"; L "no client pricing or state control" |
| …and cannot be raised afterwards | **ported:** LG "a member cannot write price, money, terms…" |
| The trusted path can still write the authoritative price | **proven:** PT "an eligible adult with a card creates a job; terms frozen" |
| Creating an ordinary request still works | **proven:** L "creates a priced, pending v2 job" |
| Another signed-in user cannot see it | **proven:** AB "another member gets nothing" |
| `fetch_base_fee_pence` applies the road factor, rate and floor | **proven:** PT "standard: mileage at 65p × 1.40…", "£4 minimum… £8 bulky" (v2 uses `fetch_v2_price`) |
| The browser preview quotes the same rate the server charges | **retired:** v2 has no client preview; the quote comes from the server (PT "quotes write nothing") |
| The service fee mirrors the commission config | **proven:** PT "only one SQL function reads the fee configuration" |
| Distance is measured with a server key | **proven:** PT "locations are the server's: client coordinates and prices are ignored" |
| The rate-limit result is tested for a refusal | **proven:** PT "rate limited per member… before anything costly" |
| An unmeasurable distance falls to the minimum, loudly | **retired:** v2 deliberately refuses instead (PT "unresolved… clean refusals, never a minimum price") |
| Re-pricing a matched delivery is refused | **ported:** LG "a member cannot write…"; PT "terms cannot be edited by anyone" |
| The write is conditional on still being pending | **retired:** the v1 trigger shape; v2 terms are frozen at create (PT) |
| Only the request's owner may price it | **retired:** v2 clients never price; the service creates on the member's behalf (L "clients cannot create") |
| Authorise refuses a delivery that was never priced | **proven:** v2 claim raises "Fetch terms missing"; every v2 job is priced at create (L) |
| The Stripe amount is base + configured service fee | **proven:** P "a valid accept places one manual-capture hold: frozen max amount… service fee as application fee" |
| Capture measures the waiting fee instead of reading the row | **proven:** L "legitimate waiting… capped… arriving again never restarts"; P "with waiting time: total + the measured waiting fee" |
| The captured amount is server-derived | **proven:** P "clients cannot set any money"; P §3 capture |
| Manual capture untouched | **retired:** v1 code shape |
| The waiting amount is derived from timestamps | **proven:** L §waiting; AJ F |
| Only the assigned driver can stop the clock | **proven:** L "only the assigned driver collects" |
| The clock is the database's | **proven:** L "a client cannot manufacture waiting"; AB "WAITING TIME: no client can create or alter a waiting event" |
| The driver's screen calls the transition instead of writing money | **retired:** v1 web `DriverActions` source contract; the v2 web and app guards cover their own clients |
| A second arrival cannot restart the clock | **proven:** L "arriving again never restarts or extends the clock" |
| Waiting is only charged when the customer said ready | **proven:** L "no waiting fee unless the requester said the item was ready" |

## fetch-price-lock (13 guarantees): 9 proven, 1 ported, 3 retired

| Guarantee | Disposition |
|---|---|
| A price rise mid-delivery cannot enlarge a held charge (scenario) | **ported:** LG "fetch-price-lock · a price rise mid-delivery… capture uses the frozen terms" (end to end through the real deliver handler) |
| Terms frozen onto the authorisation | **proven:** PT "terms frozen"; PT "the hold, the waiting cap and the return all use the job's frozen terms" |
| Capture stays inside the hold despite the rise | **proven:** PT, as above; LG |
| Waiting fee still measured under the OLD rules | **proven:** PT "the hold, the waiting cap…" |
| Authorisation freezes base, service and every waiting rule | **proven:** PT |
| Capture asks for the total under those terms | **proven:** P §3 "normal delivery: capture only the expected total" |
| Live commission config only the legacy fallback | **retired:** v1 fallback |
| Waiting fee prefers frozen terms | **proven:** PT |
| Authorised maximum persisted, not recomputed | **proven:** P "frozen max amount" |
| Old claim signature dropped | **retired:** v1 migration hygiene |
| Base fee still the one Fix 1 stored | **retired:** v1 |
| Clamp records a mismatch rather than quietly taking less | **proven:** P "owed more than Stripe can capture: no capture attempted, a payment issue escalated" |
| A price change still applies to the next Fetch | **proven:** PT "after every live price changes, the job is unchanged — and a fresh quote uses the new prices" |

## fetch-authorisation-truth (21 guarantees): 13 proven, 3 ported, 5 retired

| Guarantee | Disposition |
|---|---|
| Only requires_capture is a hold (requires_action, requires_payment_method, processing, unknown, succeeded, canceled) | **ported:** LG "only requires_capture is a hold — every other Stripe status is not authorised" (full table + unknown fails closed) |
| Nothing but authorised counts as funded | **ported:** LG "without a confirmed hold the driver is not released" |
| authorise-payment believes Stripe, not the HTTP code / stores what it means | **proven:** P "3DS needed…", "a declined card…" (v2 handlers classify `pi.status` via `fetch_v2_apply_payment_state`) |
| A non-hold returns authorised:false and does not release the driver | **proven:** P "3DS needed: … cannot be collected"; LG |
| The intent id is kept whatever the outcome | **proven:** P "Stripe unavailable: … the retry uses the SAME key — one intent" |
| "Charged on delivery" only promised once the hold is real | **retired:** v1 notification copy; the v2 notification kinds are in the Step 8 suite |
| Default card honoured only when still attached; first card promoted; used by authorise | **retired:** generic saved-card infrastructure (`chargeableCardFor`), not Fetch; v2 uses it unchanged |
| No saved card is recoverable: intent created unconfirmed; customer completes the same intent | **proven:** P "no saved card at all: requester action required"; P "3DS needed… completes it" |
| The continuation endpoint only continues; creates no PaymentIntent | **proven:** P "3DS… the requester gets a client secret and completes it" (one intent); P §8 "only the requester ever sees a client secret" |
| The one exception is gated on Stripe, the customer and a generation | **proven:** P §5 rotation tests |
| The intent comes from our row, never the request body | **proven:** P "clients cannot set any money: … payment_intent_id … ignored" |
| Only the customer who owns the request may continue it | **proven:** P "nobody else gets the secret" |
| Stripe is re-read and the row corrected | **proven:** P §7 webhook reconciliation |
| The browser never asserts success | **proven:** P (refresh reads Stripe); web and app `bankCheckResult` tests |
| An abandoned challenge resumes the same intent | **proven:** P "3DS… completes it" (same intent) |

## fetch-authorisation-idempotency (24 guarantees): 15 proven, 3 ported, 6 retired

| Guarantee | Disposition |
|---|---|
| Twenty drivers accepting at once produce one hold / exactly one caller may create | **ported:** LG "twenty simultaneous hold claims for one job" (20 real connections); LG "twenty drivers claiming one job at once" |
| The delivery owns exactly one attempt row | **ported:** LG (count = 1 after the race) |
| A different customer cannot take over the attempt | **retired:** v1 RPC shape; v2 claim is keyed to the assigned driver (`previous_hold_not_retired`; PT "only the assigned driver can start a hold") |
| Settling stores the intent and the claim resumes | **proven:** P "a lost response… the retry gets the same intent back" |
| A second, different intent is refused rather than orphaning the first | **proven:** P §7 "scoped: a retired generation's intent… change nothing"; `apply_payment_state` `not_current_hold` |
| Settling without an id never erases ours | **proven:** P (webhook scoping) |
| The row cannot be pointed at a different intent | **proven:** AB "nobody can insert, update or delete requests…"; LG |
| Retiring the attempt makes a further claim terminal | **proven:** P §4 "driver release: void, terminal, archived; next hold generation 2" |
| cancel-payment retires it / authorise refuses a terminal attempt | **retired:** v1 functions (v2: P §4) |
| An authenticated caller cannot read, write or call the registry RPCs | **proven:** P "the payment state functions are service-only"; PT "clients cannot call either function" |
| Functions pinned and service-role only | **proven:** P §8 |
| The key is derived from the delivery only, nothing random or time-based | **ported:** LG "the Stripe keys are derived from the job and the intent only" |
| Two deliveries cannot share a key | **proven:** LG (key contains the job id); P "generation 2 … new key" |
| The intent is recorded before anything that can fail | **proven:** P "Stripe unavailable: payment pending… same key" |
| Every retry resumes the same intent; reports current state; in-flight told to wait; authorised short-circuits | **proven:** P §1 lost response / outage; claim `in_flight` outcome exercised in LG race |
| The customer continuation uses the stored intent only | **proven:** P "3DS… completes it" |
| v1 web/app callers | **retired** |

## fetch-hold-expiry (25 guarantees): 17 proven, 2 ported, 6 retired

| Guarantee | Disposition |
|---|---|
| A live requires_capture hold releases the driver | **proven:** P §2 "a live, sufficient… hold allows collection" |
| A canceled intent is an expired hold; no driver released | **proven:** P §2 "an expired hold blocks collection" |
| requires_capture past its deadline is expired / close to deadline is expiring_soon | **proven:** P §2 "a hold that expires too soon blocks collection"; **ported:** LG "Stripe's deadline, not ours" |
| No deadline from Stripe means none invented / unexpanded charge yields none | **retired:** v1 `capture_before` extraction code (v2 takes `capture_before` from the PaymentIntent the gateway returns) |
| Every non-hold status fails closed / the driver is never told to carry on | **proven:** LG truth table + collection refusal |
| Valid recent hold lets the driver collect; Stripe says expired → Stripe wins; stale confirmation blocks | **proven:** P §2 (all three) |
| THE MEASURED DEFECT: no authorisation at all no longer collects | **proven:** L "the hold check is load-bearing: without it a driver could collect with no money held" |
| The direct PATCH route stays shut | **proven:** AB "nobody can insert, update or delete requests…" |
| A captured payment is never walked backwards by a later expiry | **ported:** LG "a captured payment is never walked backwards"; P §7 "out of order" |
| A hold the customer cancelled stays cancelled | **proven:** P §4 "requester asks to cancel, driver agrees: void and retire" |
| A delivery with no attempt row still has its stale status corrected | **retired:** v1 sweep |
| A live hold cannot be replaced / twenty attempts produce one generation 2 | **proven:** P §5 "never two live" (sequential); LG race covers concurrent claim |
| The replacement keeps frozen terms and drops the dead intent | **proven:** P §5; PT |
| A stranger cannot re-authorise / a captured delivery is never re-authorised | **proven:** PT "only the assigned driver can start a hold"; P §5 "after collection… never replaced" |
| Hold RPCs service-role only; generation archive server-only; client cannot set expiry state or intent id | **proven:** P §8; AB |

## fetch-capture-recovery (27 guarantees): 19 proven, 2 ported, 6 retired

| Guarantee | Disposition |
|---|---|
| Twenty taps on Deliver take the money once / exactly one caller may reach Stripe | **ported:** LG "twenty simultaneous capture claims" (20 real connections) |
| A driver who is not the assigned one is refused | **ported:** LG (`wrong_driver`); P "only the assigned driver can deliver" |
| Once captured, a further tap is an idempotent success | **proven:** P "a repeated deliver is safe: one capture"; AJ H |
| The attempt records when and how much / the registry stays server-only | **proven:** P §3, §8 |
| The intent is retrieved before capture; an already-succeeded intent is recovered | **proven:** P "a lost capture response: the retry returns the original capture" |
| A canceled or lapsed intent ends the attempt with no capture | **proven:** P §2/§5 |
| Not requires_capture fails closed; the intent comes from the registry | **proven:** P; LG |
| An unknown outcome is asked about, not assumed (ambiguous, re-read, retryable under the same key, unresolved vs failed) | **proven:** P "a lost capture response…", "a failed capture: the job stays collected, a payment issue opens"; webhook reconciliation |
| The capture key is stable, derived from the delivery, differs from the authorisation key | **ported:** LG "the Stripe keys… `fetch-v2-capture-<pi>`" |
| In-flight recorded before Stripe is called | **proven:** `claim_fetch_capture` `in_flight`, exercised by the LG race |
| Stripe cannot deliver a parcel: completion recorded separately; delivered written on that request | **proven:** L "recorded only after capture, by the assigned driver"; P "delivery checks that do not involve money run BEFORE the capture" |
| The webhook is idempotent and cannot start a capture | **proven:** P §7 "replay is silent" |
| The capture cannot exceed what is held | **proven:** P "owed more than Stripe can capture" |
| v1 capture-payment source contracts (6 tests) | **retired** |

## fetch-first-card (20 guarantees): 3 proven, 1 ported, 16 retired

| Guarantee | Disposition |
|---|---|
| The 400 that stranded the delivery is gone / no dead end for a first-time customer | **ported:** LG "a requester with no Stripe Customer: refused in words, back to the board, no orphan intent". v2 also requires a card at create (PT "card on file is required: none → 402"), so the v1 dead end cannot arise |
| A Customer that cannot be established refuses rather than half-proceeding | **proven:** PT "Stripe cannot be asked → 503 card_check_failed; nothing created" |
| No card means an unconfirmed intent / the customer completes that intent / SCA stays on the same intent | **proven:** P "no saved card…", "3DS… completes it" |
| The customer registry (claimed once, twenty callers one creator, binding adoption, refusal of a second Customer, metadata recovery, deterministic key, seeding) | **retired, not Fetch-specific:** generic Stripe-customer infrastructure shared by every OneShetland purchase. Fetch v2 only reads `profiles.stripe_customer_id` (`fetch-v2-payment-deps.ts` `customerCard`) and never creates a Customer, so its proofs belong with the payments-infrastructure suites, not Fetch |
| The panel offers card entry without a detour; the global saved-card policy is untouched | **retired:** v1 web panel; saved-card policy is not Fetch |
| Whose Customer it is (the delivery customer's, never the caller's) | **proven:** P "a valid accept… pm_REQ" (the requester's card, not the driver's) |

**Totals: 154 guarantees; 91 proven, 15 ported, 48 retired.**

**Client gap found while porting:** `fetch-v2-accept` returns the code `requester_has_no_payment_profile`, which is not in `FETCH_MESSAGES`, so the website and app would show "Something went wrong" to the driver. Not fixed here (it's client copy, owned by the web/app branches).
