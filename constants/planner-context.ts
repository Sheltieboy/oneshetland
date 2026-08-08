/**
 * Planner context — the vocabulary the day planner reads.
 *
 * The RN twin of the web's lib/planner-context.ts. Keep the two in step: a
 * chip an owner ticks in the app is the same string the planner reads and the
 * same string Peerie Bot is shown, so a key that exists on one side and not
 * the other is a business quietly dropping out of plans.
 */

export type PlannerSetting = 'indoor' | 'outdoor' | 'both';
export type PlannerBooking = 'none' | 'advised' | 'required';

export type PlannerContext = {
  /** null = nobody has said, and the planner carries on as before. */
  planner_visitor_ready: boolean | null;
  planner_dwell_minutes: number | null;
  planner_setting: PlannerSetting | null;
  planner_good_for: string[] | null;
  planner_booking: PlannerBooking | null;
  planner_note: string | null;
};

export const EMPTY_PLANNER_CONTEXT: PlannerContext = {
  planner_visitor_ready: null,
  planner_dwell_minutes: null,
  planner_setting: null,
  planner_good_for: null,
  planner_booking: null,
  planner_note: null,
};

/** Fixed list — chips can be reasoned over, free-text adjectives cannot. */
export const GOOD_FOR: { key: string; label: string }[] = [
  { key: 'families',            label: 'Families' },
  { key: 'wet_day',             label: 'A wet day' },
  { key: 'quick_stop',          label: 'A quick stop' },
  { key: 'proper_visit',        label: 'A proper visit' },
  { key: 'food_on_site',        label: 'Food on site' },
  { key: 'dogs',                label: 'Dogs welcome' },
  { key: 'accessible',          label: 'Step-free access' },
  { key: 'free',                label: 'Free to visit' },
  { key: 'stay_overnight',      label: 'Somewhere to stay' },
  { key: 'local_shop_food_etc', label: 'Local shop — food and essentials' },
  { key: 'quick_food_stop',     label: 'A quick bite' },
];

/** Real numbers to pick from, not a free-text box. */
export const DWELL_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 15,  label: 'About 15 minutes' },
  { minutes: 30,  label: 'About half an hour' },
  { minutes: 45,  label: 'About 45 minutes' },
  { minutes: 60,  label: 'About an hour' },
  { minutes: 90,  label: 'An hour and a half' },
  { minutes: 120, label: 'A couple of hours' },
  { minutes: 240, label: 'Half a day' },
];

export const SETTINGS: { key: PlannerSetting; label: string }[] = [
  { key: 'indoor',  label: 'Indoors' },
  { key: 'outdoor', label: 'Outdoors' },
  { key: 'both',    label: 'A bit of both' },
];

export const BOOKINGS: { key: PlannerBooking; label: string }[] = [
  { key: 'none',     label: 'Just turn up' },
  { key: 'advised',  label: 'Booking advised' },
  { key: 'required', label: 'Booking required' },
];

export const NOTE_MAX = 140;

/** True once the owner has said anything at all worth saving. */
export function hasPlannerContext(c: PlannerContext): boolean {
  return (
    c.planner_visitor_ready !== null ||
    c.planner_dwell_minutes !== null ||
    c.planner_setting !== null ||
    c.planner_booking !== null ||
    (c.planner_good_for?.length ?? 0) > 0 ||
    !!c.planner_note
  );
}
