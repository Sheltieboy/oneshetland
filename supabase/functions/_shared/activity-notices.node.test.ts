/**
 * activity-notices.node.test.ts — the follower-notification rules, with a fake outbox and a fake sender (no database, no push service).
 * Run: node --test supabase/functions/_shared/activity-notices.node.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runActivityNotices, buildMessage, londonWhen, lineFor, SETTLE_MS, type Deps, type NoticeRow, type PushResult } from "./activity-notices.ts";

const NOW = new Date("2026-11-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
let n = 0;
const row = (over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: `n${++n}`, activity_id: "act-1", kind: "cancelled", session_key: `rule:r1:2026-11-13`, session_starts_at: "2026-11-13T10:30:00Z",
  new_starts_at: null, new_venue: null, note: null, state_hash: "h1", created_at: ago(10 * 60_000), ...over });

function world(rows: NoticeRow[], opts: { followers?: string[]; push?: PushResult; pub?: boolean; last?: Record<string, string> } = {}) {
  const log = { pushes: [] as { users: string[]; msg: { title: string; body: string; data: Record<string, unknown> } }[], processed: [] as string[], saved: [] as { session_key: string; state_hash: string }[] };
  const deps: Deps = {
    now: () => NOW,
    loadPending: async () => rows,
    loadLastStates: async (keys) => new Map(Object.entries(opts.last ?? {}).filter(([k]) => keys.includes(k))),
    loadActivity: async (id) => ({ id, title: "Bressay Under 5s", slug: "bressay-under-5s", is_public: opts.pub ?? true }),
    loadFollowers: async () => opts.followers ?? ["u1", "u2"],
    push: async (users, msg) => { log.pushes.push({ users, msg }); return opts.push ?? { sent: users.length, skipped: 0, errored: 0 }; },
    markProcessed: async (ids) => { log.processed.push(...ids); },
    saveStates: async (r) => { log.saved.push(...r); },
  };
  return { deps, log };
}

test("one cancellation: one message to the followers, then the row is consumed and the state remembered", async () => {
  const r = row({ note: "Instructor ill" });
  const { deps, log } = world([r]);
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 1);
  assert.deepEqual(log.pushes[0].users, ["u1", "u2"]);
  assert.equal(log.pushes[0].msg.title, "Bressay Under 5s");
  assert.equal(log.pushes[0].msg.body, "Fri 13 Nov 10:30 is cancelled (Instructor ill)");
  assert.equal(log.pushes[0].msg.data.url, "https://oneshetland.com/whats-on/regular/bressay-under-5s");
  assert.deepEqual(log.processed, [r.id]);
  assert.deepEqual(log.saved, [{ session_key: r.session_key, activity_id: "act-1", state_hash: "h1" }]);
  assert.equal(s.messages, 1);
});
test("times are Shetland's: a summer-time session shows its local hour, not UTC", () => {
  assert.equal(londonWhen("2026-07-04T09:30:00Z"), "Sat 4 Jul 10:30");
  assert.equal(londonWhen("2026-11-07T10:00:00Z"), "Sat 7 Nov 10:00");
});
test("several edits to ONE session inside the window collapse to the last: one message, every older row consumed", async () => {
  const a = row({ state_hash: "h1", created_at: ago(30 * 60_000) }), b = row({ state_hash: "h2", kind: "changed", new_starts_at: "2026-11-14T10:00:00Z", created_at: ago(20 * 60_000) });
  const { deps, log } = world([a, b]);
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 1);
  assert.equal(log.pushes[0].msg.body, "Fri 13 Nov 10:30 has moved to Sat 14 Nov 10:00");
  assert.deepEqual(new Set(log.processed), new Set([a.id, b.id]));
  assert.equal(s.superseded, 1);
});
test("several sessions of one activity become ONE message (no flood), summarised", async () => {
  const rows = ["2026-11-13", "2026-11-20", "2026-11-27"].map((d) => row({ session_key: `rule:r1:${d}`, session_starts_at: `${d}T10:30:00Z`, state_hash: `h-${d}` }));
  const { deps, log } = world(rows);
  await runActivityNotices(deps);
  assert.equal(log.pushes.length, 1);
  assert.equal(log.pushes[0].msg.body, "3 changes to upcoming sessions. Open to see the latest times.");
  assert.equal(log.saved.length, 3);
});
test("a state followers already heard is NOT sent again, but the row is consumed", async () => {
  const r = row();
  const { deps, log } = world([r], { last: { [r.session_key]: "h1" } });
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 0); assert.equal(s.identical, 1); assert.deepEqual(log.processed, [r.id]);
});
test("cancelled then restored before anything was sent: nothing is sent at all", async () => {
  const c = row({ created_at: ago(30 * 60_000) }), back = row({ kind: "restored", state_hash: "h-restored", created_at: ago(20 * 60_000) });
  const { deps, log } = world([c, back]);
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 0); assert.equal(s.neverTold, 1); assert.deepEqual(new Set(log.processed), new Set([c.id, back.id]));
});
test("restored AFTER followers were told it was cancelled: they are told it is back on", async () => {
  const back = row({ kind: "restored", state_hash: "h-restored" });
  const { deps, log } = world([back], { last: { [back.session_key]: "h1" } });
  await runActivityNotices(deps);
  assert.equal(log.pushes[0].msg.body, "Fri 13 Nov 10:30 is back on");
});
test("very recent rows are left alone (the organiser is probably still editing)", async () => {
  const fresh = row({ created_at: ago(SETTLE_MS - 1000) });
  const { deps, log } = world([fresh]);
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 0); assert.equal(s.settling, 1); assert.deepEqual(log.processed, []);
});
test("a session that has already started is not announced", async () => {
  const r = row({ session_starts_at: "2026-11-10T09:00:00Z" });
  const { deps, log } = world([r]);
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 0); assert.equal(s.past, 1); assert.deepEqual(log.processed, [r.id]);
});
test("an activity that is no longer public (paused, draft, unapproved hub) sends nothing", async () => {
  const { deps, log } = world([row()], { pub: false });
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 0); assert.equal(s.inactive, 1);
});
test("no followers: nothing is sent, the row is consumed", async () => {
  const r = row();
  const { deps, log } = world([r], { followers: [] });
  const s = await runActivityNotices(deps);
  assert.equal(log.pushes.length, 0); assert.equal(s.noFollowers, 1); assert.deepEqual(log.processed, [r.id]);
});
test("delivery is NOT assumed: if every attempt errored the rows stay in the outbox for the next run, and the state is not recorded", async () => {
  const r = row();
  const { deps, log } = world([r], { push: { sent: 0, skipped: 0, errored: 2 } });
  const s = await runActivityNotices(deps);
  assert.equal(s.retained, 1); assert.deepEqual(log.processed, []); assert.deepEqual(log.saved, []); assert.equal(s.errored, 2);
});
test("people with no device (skipped / no token) still count as handled: the in-app inbox row is the record, so it is not retried forever", async () => {
  const { deps, log } = world([row()], { push: { sent: 0, skipped: 2, errored: 0 } });
  const s = await runActivityNotices(deps);
  assert.equal(s.retained, 0); assert.equal(log.processed.length, 1);
});
test("messages: extra session, venue change, break, and a note-only change", () => {
  const a = { id: "x", title: "Barre", slug: "barre", is_public: true };
  assert.equal(buildMessage(a, [row({ kind: "extra", session_starts_at: "2026-11-10T18:00:00Z" })]).body, "Extra session on Tue 10 Nov 18:00");
  assert.equal(lineFor(row({ kind: "changed", new_venue: "Hall B" })), "Fri 13 Nov 10:30 is now at Hall B");
  assert.equal(lineFor(row({ kind: "break", note: "21 Dec – 4 Jan Christmas break" })), "no sessions 21 Dec – 4 Jan Christmas break");
  assert.equal(lineFor(row({ kind: "changed", note: "Bring a mat" })), "update for Fri 13 Nov 10:30 (Bring a mat)");
});
test("nothing pending: nothing happens", async () => {
  const { deps, log } = world([]);
  const s = await runActivityNotices(deps);
  assert.equal(s.pending, 0); assert.equal(log.pushes.length, 0);
});
test("the sender never sends email and never schedules reminders (source check)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["./activity-notices.ts", "../notify-activity-changes/index.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /sendEmail|send-email|postmark/i, `${f} sends no email`);
    assert.doesNotMatch(src, /reminder/i, `${f} sends no reminders`);
  }
});
