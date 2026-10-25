/**
 * present.ts — how Fetch v2 is described to members (pure; tested under node). Plain UK English: no database states, payment
 * mechanics or internal codes ever reach the screen through anything but these maps.
 */
import type { BoardItem, Quote, Run, Size, TimelineEvent } from "@/lib/fetch-api";

export const SIZE: Record<Size, { label: string; hint: string }> = {
  small: { label: "Small", hint: "Fits on a car seat — a parcel, a bag of shopping, a prescription." },
  medium: { label: "Medium", hint: "Fills a car boot — boxes, a suitcase, a small table." },
  large: { label: "Large", hint: "Needs folded seats or an estate — a bike, flat-pack furniture." },
  bulky: { label: "Bulky", hint: "Needs a van or trailer — a sofa, a fridge, a bed." },
};
export const sizeLabel = (s?: string) => (s && s in SIZE ? SIZE[s as Size].label : "—");

export const TIMING: Record<string, { label: string; hint: string }> = {
  asap: { label: "As soon as possible", hint: "Open to drivers for 24 hours." },
  by: { label: "By a particular time", hint: "A driver needs to bring it before then." },
  flexible: { label: "I'm flexible", hint: "Easier to match with someone already going that way." },
};

export type Tone = "neutral" | "good" | "attention" | "done" | "muted";
export type HumanStatus = { label: string; tone: Tone; detail: string };

/** The requester's view of where their Fetch is. Never a raw status. */
export function requesterStatus(r: { status?: string; payment_status?: string; cancel_requested_at?: string | null; collected_at?: string | null }): HumanStatus {
  switch (r.status) {
    case "pending": return { label: "Looking for someone", tone: "neutral", detail: "Drivers going that way can see your Fetch." };
    case "matched":
      if (r.cancel_requested_at) return { label: "Cancellation asked", tone: "attention", detail: "We've asked your driver to agree to cancel." };
      if (r.payment_status === "authorised") return { label: "Driver found", tone: "good", detail: "Payment confirmed. Your item is ready for collection by your driver." };
      if (r.payment_status === "requires_action") return { label: "Payment needs your attention", tone: "attention", detail: "A driver has accepted. Please confirm the payment with your bank below." };
      if (r.payment_status === "requires_payment_method") return { label: "Payment needs your attention", tone: "attention", detail: "Your card was declined. Please update it in your payments." };
      return { label: "Waiting for payment confirmation", tone: "neutral", detail: "A driver has accepted. We're confirming the payment authorisation with your bank." };
    case "collected": return { label: "On its way", tone: "good", detail: "Collected — your item is with your driver." };
    case "undeliverable": return { label: "Needs attention", tone: "attention", detail: "Your driver couldn't deliver it. OneShetland will help sort out what happens next." };
    case "delivered": return { label: "Delivered", tone: "done", detail: "Your Fetch is complete." };
    case "returned": return { label: "Returned", tone: "done", detail: "The item was returned. OneShetland has recorded the outcome." };
    case "cancelled": return { label: "Cancelled", tone: "muted", detail: "This Fetch was cancelled." };
    case "expired": return { label: "No driver found", tone: "muted", detail: "No one took this Fetch in time. You can post it again." };
    default: return { label: "—", tone: "muted", detail: "" };
  }
}

/**
 * The driver's view of a job they hold. `driverProblem` is the server's own reason this driver can't take Fetch work right now (an expired
 * document, a paused account — fetch_v2_my_eligibility().driver_problem). It blocks collection, so it overrides any "ready" headline:
 * the payment may be confirmed, but the JOB is not ready for this driver to collect.
 */
export function driverStatus(r: { status?: string; payment_status?: string; cancel_requested_at?: string | null }, driverProblem?: string | null): HumanStatus {
  switch (r.status) {
    case "matched":
      if (r.cancel_requested_at) return { label: "Cancellation asked", tone: "attention", detail: "The requester has asked to cancel. Please agree or decline." };
      if (driverProblem) return { label: "Collection is paused", tone: "attention",
        detail: r.payment_status === "authorised" ? "The requester's payment is confirmed, but you can't collect the item until your driver details are sorted."
          : "You can't collect the item until your driver details are sorted." };
      if (r.payment_status === "authorised") return { label: "Ready for collection", tone: "good", detail: "Payment is confirmed. You can collect the item." };
      return { label: "Waiting for payment confirmation", tone: "attention", detail: "Please don't collect yet — the requester's payment isn't confirmed." };
    case "collected": return { label: "With you", tone: "good", detail: "Deliver the item, or tell us if you can't." };
    case "undeliverable": return { label: "Couldn't deliver", tone: "attention", detail: "Keep the item safe. Report the return when it's back with the sender." };
    case "delivered": return { label: "Delivered", tone: "done", detail: "Thank you — this job is complete." };
    case "returned": return { label: "Returned", tone: "done", detail: "OneShetland has recorded the outcome." };
    case "cancelled": return { label: "Cancelled", tone: "muted", detail: "This job was cancelled." };
    default: return { label: "—", tone: "muted", detail: "" };
  }
}

/** The event history in words. Internal events (holds, rotations, captures) are not shown to members. */
const EVENT: Record<string, { requester?: string; driver?: string }> = {
  created: { requester: "Fetch posted", driver: "Fetch posted" },
  claimed: { requester: "A driver accepted", driver: "You accepted this Fetch" },
  payment_authorised: { requester: "Payment confirmed", driver: "Payment confirmed" },
  payment_requires_action: { requester: "Your bank asked you to confirm the payment" },
  payment_requires_payment_method: { requester: "Your card was declined" },
  ready_confirmed: { requester: "You said the item is ready", driver: "The item is ready to collect" },
  arrived: { requester: "Your driver arrived for collection", driver: "You arrived — waiting started" },
  collected: { requester: "Item collected", driver: "Item collected" },
  delivered: { requester: "Delivered", driver: "Delivered" },
  undeliverable: { requester: "Your driver couldn't deliver it", driver: "You couldn't deliver it" },
  return_reported: { requester: "The return was reported", driver: "Return reported — OneShetland will review it" },
  return_resolved: { requester: "OneShetland recorded the outcome", driver: "OneShetland recorded the outcome" },
  cancellation_requested: { requester: "You asked to cancel", driver: "The requester asked to cancel" },
  cancellation_agreed: { requester: "Your driver agreed to cancel", driver: "You agreed to cancel" },
  cancellation_declined: { requester: "Your driver asked to go ahead", driver: "You asked to go ahead" },
  cancellation_resolved: { requester: "OneShetland decided the cancellation", driver: "OneShetland decided the cancellation" },
  cancelled: { requester: "You cancelled this Fetch" },
  admin_cancelled: { requester: "OneShetland cancelled this Fetch", driver: "OneShetland cancelled this job" },
  released: { requester: "Your driver couldn't do it — back with drivers", driver: "You released this job" },
  returned_to_board: { requester: "OneShetland put it back with drivers", driver: "OneShetland took you off this job" },
  payment_timeout: { requester: "Payment wasn't confirmed in time — back with drivers", driver: "Released: payment wasn't confirmed in time" },
  extended: { requester: "You gave drivers more time" },
  expired: { requester: "No driver took it in time" },
  message_sent: {}, issue_reported: { requester: "A problem was reported", driver: "A problem was reported" },
  issue_resolved: { requester: "OneShetland resolved a problem", driver: "OneShetland resolved a problem" },
  photo_added: {}, description_redacted: { requester: "OneShetland edited the item description" },
};
export function timelineFor(viewer: "requester" | "driver", events: TimelineEvent[]): { at: string; text: string }[] {
  return events.map((e) => ({ at: e.created_at, text: EVENT[e.event]?.[viewer] ?? "" })).filter((e) => e.text);
}

/** The price, line by line, and the hold explained — never the hold as the price. */
export function moneyLines(q: Quote): { lines: [string, number][]; total: number; hold: number | null; holdNote: string | null } {
  const lines: [string, number][] = [["Driver payment", q.driver_delivery_pence]];
  if (q.ferry_supplement_pence > 0) lines.push(["Ferry journey extra", q.ferry_supplement_pence]);
  lines.push(["OneShetland fee", q.service_fee_pence]);
  const holdHigher = q.max_authorisation_pence > q.expected_total_pence;
  return {
    lines, total: q.expected_total_pence,
    hold: holdHigher ? q.max_authorisation_pence : null,
    holdNote: holdHigher
      ? "The higher amount is only temporarily reserved in case there is waiting time or the item has to be returned. You are only charged for what actually happens."
      : null,
  };
}
export const pounds = (p: number | null | undefined) => (p === null || p === undefined ? "—" : `£${(p / 100).toFixed(2)}`);

export const ISSUE_KINDS: { value: string; label: string; who: "both" | "requester" | "driver" }[] = [
  { value: "not_delivered", label: "It hasn't arrived", who: "requester" },
  { value: "damaged", label: "The item was damaged", who: "both" },
  { value: "wrong_item", label: "Wrong item", who: "both" },
  { value: "payment", label: "A payment problem", who: "both" },
  { value: "safety", label: "A safety concern", who: "both" },
  { value: "driver_conduct", label: "The driver's behaviour", who: "requester" },
  { value: "requester_conduct", label: "The requester's behaviour", who: "driver" },
  { value: "other", label: "Something else", who: "both" },
];
export const UNDELIVERABLE: { value: string; label: string }[] = [
  { value: "recipient_absent", label: "Nobody was there to receive it" }, { value: "address_wrong", label: "The address was wrong or couldn't be found" },
  { value: "item_refused", label: "The recipient refused it" }, { value: "not_as_described", label: "The item wasn't as described" },
  { value: "damaged", label: "The item was damaged" }, { value: "vehicle_unsuitable", label: "My vehicle wasn't suitable" },
  { value: "driver_unable", label: "I couldn't complete it" }, { value: "other", label: "Something else" },
];
export const RELEASE: { value: string; label: string }[] = [
  { value: "changed_plans", label: "My plans changed" }, { value: "vehicle_unsuitable", label: "It won't fit in my vehicle" },
  { value: "not_as_described", label: "The item isn't as described" }, { value: "prohibited_item", label: "It's something Fetch can't carry" },
  { value: "other", label: "Something else" },
];
export const VEHICLES: { value: string; label: string; maxSize: Size }[] = [
  { value: "on_foot", label: "On foot", maxSize: "small" }, { value: "bicycle", label: "Bicycle", maxSize: "small" },
  { value: "car", label: "Car", maxSize: "medium" }, { value: "estate", label: "Estate car", maxSize: "large" },
  { value: "van", label: "Van", maxSize: "bulky" }, { value: "pickup", label: "Pickup", maxSize: "bulky" },
  { value: "car_with_trailer", label: "Car with a trailer", maxSize: "bulky" },
];

/** A verification requirement's state, in words. */
export function evidenceState(current: { status?: string; expires_on?: string | null } | null, awaiting: unknown, now = Date.now()): { label: string; tone: Tone } {
  if (awaiting) return { label: "Awaiting review", tone: "neutral" };
  if (!current) return { label: "Not supplied", tone: "attention" };
  if (current.status === "rejected") return { label: "Needs replacing", tone: "attention" };
  if (current.status === "expired") return { label: "Expired", tone: "attention" };
  if (current.status === "verified") {
    if (current.expires_on && Date.parse(current.expires_on) - now < 30 * 86400_000) return { label: `Approved — expires ${current.expires_on}`, tone: "attention" };
    return { label: current.expires_on ? `Approved until ${current.expires_on}` : "Approved", tone: "good" };
  }
  return { label: "Awaiting review", tone: "neutral" };
}

/** When a board item is needed, briefly. */
export function boardWhen(i: { scheduling_mode?: string; needed_by?: string | null; flexible_until?: string | null; expires_at?: string | null }): string {
  const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long" }) : "");
  if (i.scheduling_mode === "flexible") return `Flexible · by ${day(i.flexible_until)}`;
  if (i.scheduling_mode === "by") return `By ${day(i.needed_by)} ${i.needed_by ? new Date(i.needed_by).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }) : ""}`.trim();
  return "As soon as possible";
}
export const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

/** "Fits your Saturday journey" — the run match, said the way a driver thinks about it. */
export function matchLabel(item: Pick<BoardItem, "match" | "fits_run_id">, runs: Run[]): string | null {
  if (item.match === "your_run") {
    const run = runs.find((r) => r.id === item.fits_run_id);
    const day = run ? new Date(run.departure_start).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long" }) : null;
    return day ? `Fits your ${day} journey` : "Fits your journey";
  }
  if (item.match === "your_area") return "In your area";
  if (item.match === "beyond_vehicle") return "Too large for your vehicle";
  return null;
}

/**
 * After the bank's check (3D Secure), what to tell the requester. The server's refreshed payment state decides: a Fetch payment is a
 * hold, so a successful check leaves Stripe at requires_capture, which the generic saved-card helper does not count as success.
 */
export function bankCheckResult(serverPayment: string | null, sdk: "succeeded" | "pending" | "cancelled" | "failed"): { ok: boolean; text: string } {
  if (serverPayment === "authorised") return { ok: true, text: "Payment authorisation confirmed." };
  if (serverPayment === "requires_payment_method") return { ok: false, text: "Your bank didn't confirm it. Please update your card in your payments." };
  if (serverPayment === "requires_action" && sdk === "cancelled") return { ok: false, text: "You closed your bank's check. Nothing has been taken — you can try again." };
  if (serverPayment === "requires_action") return { ok: false, text: "Your bank didn't confirm it. Please try again." };
  return { ok: true, text: "Your bank is still checking. We'll update this page." };
}
