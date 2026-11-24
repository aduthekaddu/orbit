import assert from "node:assert/strict";
import test from "node:test";
import { currentTurnIndex, shortcutTarget, turnLabel, visibleTurns } from "./thread-map";

const shortcut = (keys: Partial<Parameters<typeof shortcutTarget>[0]>) => ({
  altKey: true,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  key: "ArrowDown",
  isComposing: false,
  ...keys,
});

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

test("alt arrow steps to the next prompt", () => {
  assert.equal(shortcutTarget(shortcut({}), 1, 3), 2);
  assert.equal(shortcutTarget(shortcut({ key: "ArrowUp" }), 1, 3), 0);
});

test("alt arrow stays at the first and last prompt", () => {
  assert.equal(shortcutTarget(shortcut({ key: "ArrowUp" }), 0, 3), 0);
  assert.equal(shortcutTarget(shortcut({}), 2, 3), 2);
});

test("alt arrow does nothing when there are no prompts", () => {
  assert.equal(shortcutTarget(shortcut({}), 0, 0), null);
  assert.equal(shortcutTarget(shortcut({ key: "ArrowUp" }), 0, 0), null);
});

test("keys other than the arrows stay with the page", () => {
  assert.equal(shortcutTarget(shortcut({ key: "PageDown" }), 1, 3), null);
});

test("shift, meta, ctrl, and plain arrows stay with the page", () => {
  assert.equal(shortcutTarget(shortcut({ shiftKey: true }), 1, 3), null);
  assert.equal(shortcutTarget(shortcut({ key: "ArrowUp", shiftKey: true }), 1, 3), null);
  assert.equal(shortcutTarget(shortcut({ metaKey: true }), 1, 3), null);
  assert.equal(shortcutTarget(shortcut({ ctrlKey: true }), 1, 3), null);
  assert.equal(shortcutTarget(shortcut({ altKey: false }), 1, 3), null);
});

test("alt arrow stays with the field while an input method is composing", () => {
  assert.equal(shortcutTarget(shortcut({ isComposing: true }), 1, 3), null);
});
