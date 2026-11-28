import assert from "node:assert/strict";
import { test } from "node:test";
import { neighbourId } from "./neighbour";

test("a removed row hands focus to the next row", () => {
  assert.equal(neighbourId(["a", "b", "c"], "a"), "b");
  assert.equal(neighbourId(["a", "b", "c"], "b"), "c");
});

test("the last row hands focus to the previous row", () => {
  assert.equal(neighbourId(["a", "b", "c"], "c"), "b");
});

test("the only row, or an unknown row, has no neighbour", () => {
  assert.equal(neighbourId(["a"], "a"), null);
  assert.equal(neighbourId([], "a"), null);
  assert.equal(neighbourId(["a", "b"], "z"), null);
});
