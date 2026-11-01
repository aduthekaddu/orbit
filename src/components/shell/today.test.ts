process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { msUntilNextMidnight, serverTodaySnapshot, subscribeToday, todaySnapshot } from "./today";

const HOUR = 3_600_000;
const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(year, month - 1, day, hour, minute, second, ms).getTime();

test("the zone set for this test is the one under assertion", () => {
  assert.equal(new Date(2026, 2, 8, 12).getTimezoneOffset(), 240);
  assert.equal(new Date(2026, 10, 1, 12).getTimezoneOffset(), 300);
});

test("the last millisecond of a day waits one millisecond", () => {
  assert.equal(msUntilNextMidnight(local(2026, 3, 8, 23, 59, 59, 999)), 1);
});

test("midnight itself waits a whole day, short or long across a DST change", () => {
  assert.equal(msUntilNextMidnight(local(2026, 3, 9)), 24 * HOUR);
  assert.equal(msUntilNextMidnight(local(2026, 3, 8)), 23 * HOUR);
  assert.equal(msUntilNextMidnight(local(2026, 11, 1)), 25 * HOUR);
  assert.equal(msUntilNextMidnight(local(2026, 6, 15, 12)), 12 * HOUR);
});

test("the delay lands on the next local midnight", () => {
  for (const now of [local(2026, 3, 8, 1, 30), local(2026, 11, 1, 1, 30), local(2026, 12, 31, 23, 59)]) {
    const day = new Date(now);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    assert.equal(now + msUntilNextMidnight(now), next.getTime());
  }
});

test("the server snapshot stays null", () => {
  assert.equal(serverTodaySnapshot(), null);
});

test("sitting idle, the store moves to the new day on the first midnight tick", () => {
  const start = local(2026, 3, 8, 23, 59);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  try {
    let seen = todaySnapshot();
    let beats = 0;
    const unsubscribe = subscribeToday(() => {
      beats += 1;
      seen = todaySnapshot();
    });

    assert.equal(seen, local(2026, 3, 8));
    mock.timers.tick(59_999);
    assert.equal(beats, 0);
    assert.equal(seen, local(2026, 3, 8));

    mock.timers.tick(1);
    assert.equal(beats, 1);
    assert.equal(seen, local(2026, 3, 9));

    mock.timers.tick(24 * HOUR);
    assert.equal(beats, 2);
    assert.equal(seen, local(2026, 3, 10));

    unsubscribe();
    mock.timers.tick(24 * HOUR);
    assert.equal(beats, 2);
  } finally {
    mock.timers.reset();
  }
});
