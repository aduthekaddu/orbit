import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getDb } from "../db";
import { user, userPreferences } from "../db/schema";
import { parseViewer } from "../policy";
import * as schedule from "./schedule";

delete process.env.ORBIT_OLLAMA_URL;
delete process.env.ORBIT_DREAM_HOUR;

after(() => {
  getDb().$client.close();
});

function requireSchedule() {
  return schedule;
}

const zone = "America/New_York";

test("before 03:00 the night does not start", () => {
  const { shouldStartDream } = requireSchedule();
  assert.equal(
    shouldStartDream({ now: new Date("2026-07-15T06:30:00Z"), hour: 3, timeZone: zone, tonight: null }),
    false,
  );
});

test("at 03:05 with no run the night starts", () => {
  const { shouldStartDream } = requireSchedule();
  assert.equal(
    shouldStartDream({ now: new Date("2026-07-15T07:05:00Z"), hour: 3, timeZone: zone, tonight: null }),
    true,
  );
});

test("a done night does not start again", () => {
  const { shouldStartDream } = requireSchedule();
  const now = new Date("2026-07-15T07:05:00Z");
  assert.equal(
    shouldStartDream({
      now,
      hour: 3,
      timeZone: zone,
      tonight: { state: "done", startedAt: new Date(now.getTime() - 60_000), leaseUntil: new Date(now.getTime() - 1_000) },
    }),
    false,
  );
});

test("a running night with an expired lease starts", () => {
  const { shouldStartDream } = requireSchedule();
  const now = new Date("2026-07-15T07:05:00Z");
  assert.equal(
    shouldStartDream({
      now,
      hour: 3,
      timeZone: zone,
      tonight: { state: "running", startedAt: new Date(now.getTime() - 60_000), leaseUntil: new Date(now.getTime() - 1_000) },
    }),
    true,
  );
});

test("a live lease holds the night after the start time is two hours old", () => {
  const { shouldStartDream } = requireSchedule();
  const now = new Date("2026-07-15T07:05:00Z");
  assert.equal(
    shouldStartDream({
      now,
      hour: 3,
      timeZone: zone,
      tonight: { state: "running", startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000), leaseUntil: new Date(now.getTime() + 60_000) },
    }),
    false,
  );
});

test("a failed night waits for a manual rerun", () => {
  const { shouldStartDream } = requireSchedule();
  const now = new Date("2026-07-15T07:05:00Z");
  assert.equal(
    shouldStartDream({
      now,
      hour: 3,
      timeZone: zone,
      tonight: { state: "failed", startedAt: new Date(now.getTime() - 60_000), leaseUntil: null },
    }),
    false,
  );
});

test("the spring-forward night starts at 03:00 local and not during the missing hour", () => {
  const { shouldStartDream } = requireSchedule();
  assert.equal(
    shouldStartDream({ now: new Date("2026-03-08T06:30:00Z"), hour: 3, timeZone: zone, tonight: null }),
    false,
  );
  assert.equal(
    shouldStartDream({ now: new Date("2026-03-08T07:30:00Z"), hour: 3, timeZone: zone, tonight: null }),
    true,
  );
});

test("the fall-back night uses the local hour after the clock repeats", () => {
  const { shouldStartDream } = requireSchedule();
  assert.equal(
    shouldStartDream({ now: new Date("2026-11-01T05:30:00Z"), hour: 3, timeZone: zone, tonight: null }),
    false,
  );
  assert.equal(
    shouldStartDream({ now: new Date("2026-11-01T06:30:00Z"), hour: 3, timeZone: zone, tonight: null }),
    false,
  );
  assert.equal(
    shouldStartDream({ now: new Date("2026-11-01T08:30:00Z"), hour: 3, timeZone: zone, tonight: null }),
    true,
  );
});

test("local midnight stays on that calendar date when the clocks change", () => {
  const { localMidnight, localStamp } = requireSchedule();
  for (const date of ["2026-03-08", "2026-11-01"]) {
    const midnight = localMidnight(date, zone);
    const stamp = localStamp(new Date(midnight), zone);
    assert.equal(stamp.date, date);
    assert.equal(stamp.minutes, 0);
  }
});

test("only accounts with memory on and an available lease are due at the saved hour", () => {
  const { dueDreamViewers, localStamp, memoryEnabledViewers } = requireSchedule();
  const db = getDb();
  const admin = parseViewer({ id: "dream-admin", role: "admin" });
  const member = parseViewer({ id: "dream-member", role: "member" });
  db.insert(user).values([
    { ...admin, name: "Admin", email: "dream-admin@orbit.test" },
    { ...member, name: "Member", email: "dream-member@orbit.test" },
  ]).run();
  db.insert(userPreferences).values({ userId: member.id, memory: "off", updatedAt: new Date() }).run();
  db.$client.prepare("UPDATE instance_settings SET dream_hour = 5 WHERE id = 1").run();

  const now = new Date();
  now.setHours(5, 5, 0, 0);
  const early = new Date(now);
  early.setHours(4);
  assert.deepEqual(memoryEnabledViewers(), [admin]);
  assert.deepEqual(dueDreamViewers(early), []);
  assert.deepEqual(dueDreamViewers(now), [admin]);

  const { date } = localStamp(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  db.$client
    .prepare(
      `INSERT INTO memory_runs (
         user_id, date, state, started_at, owner, lease_until, chat_ids, done_chat_ids, retry_chat_ids, added, merged
       ) VALUES (?, ?, 'running', ?, 'worker-a', ?, '[]', '[]', '[]', 0, 0)`,
    )
    .run(admin.id, date, now.getTime() - 1_000, now.getTime() + 1_000);
  assert.deepEqual(dueDreamViewers(now), []);
  assert.deepEqual(dueDreamViewers(new Date(now.getTime() + 2_000)), [admin]);

  db.update(userPreferences).set({ memory: "on" }).run();
  assert.deepEqual(dueDreamViewers(now), [member]);
});

test("the scheduler stays off during a build", () => {
  const { dreamSchedulerEnabled } = requireSchedule();
  const previous = process.env.NEXT_PHASE;
  process.env.NEXT_PHASE = "phase-production-build";
  try {
    assert.equal(dreamSchedulerEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previous;
  }
});
