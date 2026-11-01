import assert from "node:assert/strict";
import test from "node:test";
import { currentTurnIndex, turnLabel, visibleTurns } from "./thread-map";

test("the current turn is the last prompt above the anchor line", () => {
  assert.equal(currentTurnIndex([0, 400, 900], 450), 1);
  assert.equal(currentTurnIndex([0, 400, 900], 1200), 2);
});

test("before the first prompt reaches the anchor, the first turn is current", () => {
  assert.equal(currentTurnIndex([120, 400], 50), 0);
});

test("a turn is visible while any part of its span is in view", () => {
  assert.deepEqual(visibleTurns([0, 400, 900], 1500, 350, 950), [true, true, true]);
  assert.deepEqual(visibleTurns([0, 400, 900], 1500, 1000, 1500), [false, false, true]);
});

test("a turn is labelled by its first line", () => {
  assert.equal(turnLabel("  Plan the trip\nwith details"), "Plan the trip");
});
