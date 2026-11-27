import assert from "node:assert/strict";
import test from "node:test";
import { FOLD_AFTER_LINES, measuredFold, toggledFold } from "./messages";

// text-prose is 16px at a 1.65 line height.
const line = 26.4;

test("a user message up to 14 lines fits, with a pixel of rounding", () => {
  assert.equal(FOLD_AFTER_LINES, 14);
  assert.equal(measuredFold("fits", line * 3, line), "fits");
  assert.equal(measuredFold("fits", line * 14, line), "fits");
  assert.equal(measuredFold("fits", line * 14 + 1, line), "fits");
});

test("a user message taller than 14 lines folds", () => {
  assert.equal(measuredFold("fits", line * 14 + 2, line), "folded");
  assert.equal(measuredFold("fits", line * 40, line), "folded");
});

test("measuring again keeps the reader's choice while the message stays tall", () => {
  assert.equal(measuredFold("folded", line * 40, line), "folded");
  assert.equal(measuredFold("expanded", line * 40, line), "expanded");
});

test("a message that stops being tall, after a resize or a smaller text size, drops its toggle", () => {
  assert.equal(measuredFold("folded", line * 10, line), "fits");
  assert.equal(measuredFold("expanded", line * 10, line), "fits");
});

test("the 14-line test follows the line height, so a larger text size folds later", () => {
  const large = line * 1.25;
  assert.equal(measuredFold("fits", line * 16, large), "fits");
  assert.equal(measuredFold("fits", large * 15, large), "folded");
});

test("a line height that cannot be read never folds the message", () => {
  assert.equal(measuredFold("fits", 5000, Number.NaN), "fits");
  assert.equal(measuredFold("folded", 5000, 0), "fits");
});

test("Show more and Show less switch between folded and expanded, and a short message has no toggle", () => {
  assert.equal(toggledFold("folded"), "expanded");
  assert.equal(toggledFold("expanded"), "folded");
  assert.equal(toggledFold("fits"), "fits");
});
