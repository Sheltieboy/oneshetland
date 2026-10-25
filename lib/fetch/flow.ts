/**
 * flow.ts — the requester's create steps and which actions each person may take now (pure; tested under node).
 * The server decides everything again; this only keeps impossible choices off the screen.
 */
import type { CreateInput, Detail, Place, Size } from "@/lib/fetch-api";

export type Draft = {
  pickup: Partial<Place>; destination: Partial<Place>; pickup_name?: string; pickup_notes?: string; delivery_notes?: string;
  category_slug?: string; item_description?: string; size_class?: Size; dims?: { l?: string; w?: string; h?: string }; two_person?: boolean; fragile?: boolean;
  scheduling_mode?: "asap" | "by" | "flexible"; needed_by?: string; flexible_until?: string;
  contact_phone?: string; share_phone_with_driver?: boolean; safe_place_allowed?: boolean; safe_place_note?: string; liability_acknowledged?: boolean;
};
export const STEPS = ["Collection", "Delivery", "The item", "Timing", "Price & review"] as const;
const POSTCODE = /^ZE[1-3]\s?\d[A-Z]{2}$/i;

/** What is still missing on a step (empty = the step is complete). */
export function stepProblems(step: number, d: Draft, now = Date.now()): string[] {
  const p: string[] = [];
  const place = (x: Partial<Place>, what: string) => {
    if (!x.region_id) p.push(`Choose the area for the ${what}.`);
    if (!x.address?.trim()) p.push(`Enter the ${what} address.`);
    if (x.postcode && !POSTCODE.test(x.postcode.trim())) p.push(`That ${what} postcode isn't a Shetland postcode (ZE1, ZE2 or ZE3).`);
  };
  if (step === 0) place(d.pickup, "collection");
  if (step === 1) place(d.destination, "delivery");
  if (step === 2) {
    if (!d.category_slug) p.push("Choose what kind of item it is.");
    const desc = d.item_description?.trim() ?? "";
    if (desc.length < 3 || desc.length > 140) p.push("Describe the item in 3 to 140 characters.");
    if (!d.size_class) p.push("Choose a size.");
    if ((d.size_class === "large" || d.size_class === "bulky") && !dims(d)) p.push("Add rough measurements, so the driver can make sure it will fit.");
    if ((d.category_slug === "pharmacy" || d.category_slug === "takeaway") && !d.liability_acknowledged) p.push("Please confirm the note about this kind of item.");
  }
  if (step === 3) {
    if (!d.scheduling_mode) p.push("Choose when you need it.");
    if (d.scheduling_mode === "by") {
      const t = Date.parse(d.needed_by ?? "");
      if (!t || t < now + 30 * 60_000 || t > now + 7 * 86400_000) p.push("Choose a time from 30 minutes to 7 days from now.");
    }
    if (d.scheduling_mode === "flexible") {
      const t = Date.parse(d.flexible_until ?? "");
      if (!t || t < now + 3600_000 || t > now + 7 * 86400_000) p.push("Choose a latest time from 1 hour to 7 days from now.");
    }
    if (!/^[0-9+ ()-]{7,20}$/.test(d.contact_phone?.trim() ?? "")) p.push("Enter a phone number for the driver to reach you if needed.");
  }
  return p;
}

function dims(d: Draft): { l: number; w: number; h: number } | null {
  const n = (v?: string) => (v && /^\d{1,3}$/.test(v.trim()) ? Number(v) : NaN);
  const l = n(d.dims?.l), w = n(d.dims?.w), h = n(d.dims?.h);
  return [l, w, h].every((x) => x >= 1 && x <= 500) ? { l, w, h } : null;
}

/** The create request from a complete draft (the key makes a retried post the same Fetch). No price or money field exists here. */
export function createInput(d: Draft, idempotencyKey: string): CreateInput {
  const flags = [d.two_person ? "heavy_two_person" : null, d.fragile ? "fragile" : null].filter(Boolean) as string[];
  return {
    idempotency_key: idempotencyKey, size_class: d.size_class!, pickup: clean(d.pickup), destination: clean(d.destination),
    category_slug: d.category_slug!, item_description: d.item_description!.trim(), approx_dimensions_cm: dims(d), handling_flags: flags,
    pickup_name: d.pickup_name?.trim() || undefined, pickup_notes: d.pickup_notes?.trim() || undefined, delivery_notes: d.delivery_notes?.trim() || undefined,
    contact_phone: d.contact_phone!.trim(), share_phone_with_driver: d.share_phone_with_driver === true, safe_place_allowed: d.safe_place_allowed === true,
    safe_place_note: d.safe_place_note?.trim() || undefined, liability_acknowledged: d.liability_acknowledged === true,
    scheduling_mode: d.scheduling_mode!, needed_by: d.scheduling_mode === "by" ? new Date(d.needed_by!).toISOString() : null,
    flexible_until: d.scheduling_mode === "flexible" ? new Date(d.flexible_until!).toISOString() : null,
  };
}
const clean = (p: Partial<Place>): Place => ({ region_id: p.region_id!, address: p.address!.trim(), ...(p.postcode?.trim() ? { postcode: p.postcode.trim().toUpperCase() } : {}),
  ...(p.area?.trim() ? { area: p.area.trim() } : {}) });

export type RequesterAction = "pay" | "cancel" | "ask_cancel" | "extend" | "ready" | "photos" | "message" | "report";
/** The requester's actions that apply now — impossible ones are not offered. */
export function requesterActions(r: Detail["request"], now = Date.now()): RequesterAction[] {
  const a: RequesterAction[] = [];
  const closedFor = r.closed_at ? now - Date.parse(r.closed_at) : 0;
  if (r.status === "matched" && ["requires_action", "requires_payment_method"].includes(r.payment_status)) a.push("pay");
  if (r.status === "pending") a.push("cancel", "extend", "photos");
  if (r.status === "matched" && !r.cancel_requested_at) a.push("ask_cancel", "ready");
  if (r.driver && r.status !== "pending" && closedFor < 30 * 86400_000) a.push("message");
  if (r.status !== "expired" && closedFor < 72 * 3600_000) a.push("report");
  return a;
}

export type DriverAction = "collect" | "arrive" | "refresh_payment" | "release" | "agree_cancel" | "decline_cancel" | "deliver" | "cannot_deliver" | "report_return" | "photos" | "message" | "report";
/** `driverProblem` (the server's reason this driver can't take Fetch work now) removes arriving and collecting — both lead nowhere until it is sorted. */
export function driverActions(r: Detail["request"], now = Date.now(), driverProblem?: string | null): DriverAction[] {
  const a: DriverAction[] = [];
  const closedFor = r.closed_at ? now - Date.parse(r.closed_at) : 0;
  if (r.status === "matched") {
    if (r.cancel_requested_at) a.push("agree_cancel", "decline_cancel");
    else if (driverProblem) {
      if (r.payment_status !== "authorised") a.push("refresh_payment");
    } else {
      a.push("arrive");
      if (r.payment_status === "authorised") a.push("collect"); else a.push("refresh_payment");
    }
    a.push("release");
  }
  if (r.status === "collected") a.push("deliver", "cannot_deliver");
  if (r.status === "undeliverable") a.push("deliver", "report_return");
  if (["matched", "collected", "undeliverable"].includes(r.status)) a.push("photos");
  if (closedFor < 30 * 86400_000) a.push("message");
  if (closedFor < 72 * 3600_000) a.push("report");
  return a;
}

/** A fresh idempotency key / client reference (also used for messages and issues so a retry is the same record). */
export function newKey(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
}

/** Image types Fetch photos accept (HEIC must be converted first — the app does this; on the web the browser usually does). */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export function photoProblem(file: { type: string; size: number }): string | null {
  if (!PHOTO_TYPES.includes(file.type)) return "Please choose a JPEG, PNG or WEBP photo.";
  if (file.size > 10 * 1024 * 1024) return "That photo is too large (10 MB at most).";
  if (file.size < 1) return "That file is empty.";
  return null;
}
