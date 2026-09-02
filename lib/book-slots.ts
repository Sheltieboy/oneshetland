/**
 * book-slots.ts
 *
 * Pure slot computation for OneShetland Book.
 *
 * Combines the inputs that define a business's availability:
 *   • weekly recurring rules  (BookAvailabilityRule[])
 *   • one-off overrides       (BookSlotOverride[]   — open / closed / last_min)
 *   • existing bookings       (BookBooking[]        — blocks the slot's time)
 *
 * …and produces the list of bookable Slots for a given service inside a
 * window. Pure function — no Supabase calls.
 *
 * Timezone: slot COMPUTATION is done in the device's local timezone. Weekly
 * rule TIME values are anchored to local midnight of each day; overrides and
 * bookings are stored as TIMESTAMPTZ and converted via the JS Date.
 *
 * Slot DISPLAY is not: a Shetland appointment is a Shetland hour, so the
 * formatters and the day key below name Europe/London explicitly rather than
 * inheriting whichever clock the phone is keeping.
 */

import type {
  BookService, BookAvailabilityRule, BookSlotOverride, BookBooking,
} from './book-api';
import { SHETLAND_TZ, shetlandDayKey } from './shetland-time';

const ONE_MINUTE = 60_000;

export interface SlotComputeInput {
  service:   BookService;
  rules:     BookAvailabilityRule[];
  overrides: BookSlotOverride[];
  bookings:  BookBooking[];
  from:      Date;            // window start (inclusive)
  to:        Date;            // window end   (exclusive)
  now?:      Date;            // default = new Date()
  minLeadMinutes?: number;    // default = 30 (no slot less than 30 min from now)
}

export interface Slot {
  start:    Date;
  end:      Date;
  lastMin:  boolean;          // true → came from a 'last_min' override
  capacity: number;           // total simultaneous bookings allowed
  taken:    number;           // current bookings overlapping this slot
  isFull:   boolean;          // taken >= capacity
}

export function computeAvailableSlots(input: SlotComputeInput): Slot[] {
  const {
    service, rules, overrides, bookings,
    from, to,
    now = new Date(),
    minLeadMinutes = 30,
  } = input;

  const leadCutoff = new Date(now.getTime() + minLeadMinutes * ONE_MINUTE);
  const earliest   = from > leadCutoff ? from : leadCutoff;

  // Rules / overrides that apply to *this* service.
  // service_id IS NULL → applies to all services on the business.
  const applicableRules = rules.filter(r =>
    r.service_id == null || r.service_id === service.id
  );
  const applicableOverrides = overrides.filter(o =>
    o.service_id == null || o.service_id === service.id
  );

  const closures      = applicableOverrides.filter(o => o.type === 'closed');
  const openOverrides = applicableOverrides.filter(o => o.type === 'open' || o.type === 'last_min');

  // Walk each day in the window, generating candidate slots from weekly rules.
  // Use a Map keyed by start-time ms to dedupe overlapping rule/override slots.
  const slotMap = new Map<number, Slot>();

  const windowStart = startOfDay(from);
  const windowEnd   = startOfDay(addDays(to, 1));

  for (let day = new Date(windowStart); day < windowEnd; day = addDays(day, 1)) {
    const dow = day.getDay();
    const dayRules = applicableRules.filter(r => r.day_of_week === dow);

    for (const rule of dayRules) {
      generateSlotsInRange(
        timeOnDay(day, rule.start_time),
        timeOnDay(day, rule.end_time),
        rule.slot_interval_minutes,
        service.duration_minutes,
        service.buffer_minutes,
        /* lastMin */ false,
        slotMap,
      );
    }
  }

  // Slots from 'open' and 'last_min' overrides (additive)
  for (const ov of openOverrides) {
    const ovStart = new Date(ov.starts_at);
    const ovEnd   = new Date(ov.ends_at);
    if (ovEnd <= from || ovStart >= to) continue;
    generateSlotsInRange(
      ovStart, ovEnd,
      30,  // overrides default to 30-min interval — they're usually short windows
      service.duration_minutes,
      service.buffer_minutes,
      /* lastMin */ ov.type === 'last_min',
      slotMap,
    );
  }

  // Only confirmed / pending_payment bookings count against capacity.
  // We also restrict to bookings of THIS service — different services have
  // independent capacities. (A salon with shared chairs across services would
  // need a per-business resource model — out of scope here.)
  const blockingBookings = bookings.filter(b =>
    (b.status === 'confirmed' || b.status === 'pending_payment') &&
    b.service_id === service.id
  );

  const bufferMs = service.buffer_minutes * ONE_MINUTE;
  const capacity = Math.max(1, service.capacity ?? 1);

  const result: Slot[] = [];
  for (const slot of slotMap.values()) {
    // Last-min slots bypass the lead-time cutoff (the whole point is "now-ish")
    const cutoff = slot.lastMin ? now : earliest;
    if (slot.start < cutoff) continue;
    if (slot.end   > to)     continue;

    // Closure overlap → slot doesn't exist at all
    const inClosure = closures.some(c =>
      overlaps(slot.start, slot.end, new Date(c.starts_at), new Date(c.ends_at))
    );
    if (inClosure) continue;

    // Count overlapping bookings (include buffer on the candidate slot)
    const slotEndWithBuf = new Date(slot.end.getTime() + bufferMs);
    const taken = blockingBookings.filter(b =>
      overlaps(slot.start, slotEndWithBuf, new Date(b.starts_at), new Date(b.ends_at))
    ).length;

    result.push({
      ...slot,
      capacity,
      taken,
      isFull: taken >= capacity,
    });
  }

  return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateSlotsInRange(
  rangeStart: Date,
  rangeEnd:   Date,
  intervalMinutes: number,
  durationMinutes: number,
  bufferMinutes:   number,
  lastMin: boolean,
  out: Map<number, Slot>,
): void {
  const intervalMs = intervalMinutes * ONE_MINUTE;
  const durationMs = durationMinutes * ONE_MINUTE;
  const bufferMs   = bufferMinutes   * ONE_MINUTE;

  // Slot must end (incl. buffer) by rangeEnd to actually fit.
  for (let t = rangeStart.getTime(); t + durationMs + bufferMs <= rangeEnd.getTime(); t += intervalMs) {
    const start = new Date(t);
    const end   = new Date(t + durationMs);
    const existing = out.get(t);
    // capacity/taken/isFull are filled in by computeAvailableSlots in the
    // final pass; here we just produce candidate (lastMin) slots.
    if (existing) {
      if (lastMin && !existing.lastMin) out.set(t, { start, end, lastMin: true, capacity: 1, taken: 0, isFull: false });
    } else {
      out.set(t, { start, end, lastMin, capacity: 1, taken: 0, isFull: false });
    }
  }
}

function timeOnDay(day: Date, timeStr: string): Date {
  // timeStr is 'HH:MM' or 'HH:MM:SS'
  const [h, m] = timeStr.split(':').map(Number);
  const out = new Date(day);
  out.setHours(h, m || 0, 0, 0);
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** Group slots by YYYY-MM-DD (local date) for day-strip UIs. */
export function groupSlotsByDate(slots: Slot[]): Map<string, Slot[]> {
  const map = new Map<string, Slot[]>();
  for (const s of slots) {
    const key = dateKey(s.start);
    const arr = map.get(key);
    if (arr) arr.push(s); else map.set(key, [s]);
  }
  return map;
}

/** YYYY-MM-DD in local time (NOT UTC, so days don't shift on timezone seams). */
export function dateKey(d: Date): string {
  // The SHETLAND day, not the phone's. Local date parts filed an early slot
  // under the previous day for a customer abroad, and the tab then disagreed
  // with the time printed on the slot inside it.
  return shetlandDayKey(d);
}

/** "09:30" */
export function formatSlotTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SHETLAND_TZ });
}

/** "Tue 28 May" */
export function formatSlotDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: SHETLAND_TZ });
}
