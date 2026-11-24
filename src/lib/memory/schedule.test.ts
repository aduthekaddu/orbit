import assert from "node:assert/strict";
import test, { before } from "node:test";

delete process.env.ORBIT_OLLAMA_URL;
delete process.env.ORBIT_DREAM_HOUR;

type ScheduleModule = typeof import("./schedule");

let schedule: ScheduleModule | undefined;
let importError = "";

before(async () => {
  try {
    schedule = await import("./schedule");
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
});

function requireSchedule() {
  assert.equal(importError, "", `dream schedule is missing: ${importError}`);
  if (!schedule) throw new Error("dream schedule is missing");
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

test("maybeDream reads tonight's row", async () => {
  const { maybeDream, localStamp } = requireSchedule();
  const now = new Date();
  now.setHours(3, 5, 0, 0);
  const early = new Date();
  early.setHours(1, 5, 0, 0);
  assert.equal(maybeDream(early), false);
  assert.equal(maybeDream(now), true);
  const { db } = await import("../db");
  const date = localStamp(now, Intl.DateTimeFormat().resolvedOptions().timeZone).date;
  db.$client
    .prepare(
      `INSERT INTO memory_runs (
         date, state, started_at, finished_at, owner, lease_until, chat_ids, done_chat_ids, retry_chat_ids, added, merged, error
       ) VALUES (?, 'done', ?, ?, 'worker-a', ?, '[]', '[]', '[]', 0, 0, NULL)`,
    )
    .run(date, now.getTime() - 1_000, now.getTime(), now.getTime());
  assert.equal(maybeDream(now), false);
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
