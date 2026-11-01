import assert from "node:assert/strict";
import test from "node:test";
import { installVirtualClock } from "./clock";

type FakeWindow = {
  setTimeout: (fn: () => void, ms?: number) => number;
  clearTimeout: (id: number) => void;
};

function withVirtualClock() {
  const host = globalThis as any;
  const realNow = performance.now;
  const win = {} as FakeWindow;
  host.window = win;
  host.document = { getAnimations: () => [] };
  const clock = installVirtualClock({ fps: 60 });
  return {
    win,
    clock,
    restore() {
      performance.now = realNow;
      delete host.window;
      delete host.document;
    },
  };
}

test("a step that leaves timers queued does not report time past them", async () => {
  const { win, clock, restore } = withVirtualClock();
  try {
    const seen = [clock.now()];
    for (let i = 0; i < 10_001; i++) win.setTimeout(() => seen.push(performance.now()), 0);
    await clock.advance(16);
    seen.push(clock.now());
    await clock.advance(16);
    seen.push(clock.now());

    assert.equal(seen.length, 10_004, "every queued timer runs");
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= seen[i - 1], `virtual time went backward at sample ${i}: ${seen[i - 1]} then ${seen[i]}`);
    }
  } finally {
    restore();
  }
});
