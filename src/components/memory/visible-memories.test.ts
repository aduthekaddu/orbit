import assert from "node:assert/strict";
import test from "node:test";
import { visibleMemories } from "./visible-memories";

const initial = [{ id: "a" }, { id: "b" }];

test("a search shows matches only after that search returns", () => {
  assert.deepEqual(visibleMemories("", initial, null), initial);
  assert.deepEqual(visibleMemories("fly", initial, null), []);
  assert.deepEqual(visibleMemories("fly", initial, { query: "other", rows: initial }), []);
  assert.deepEqual(visibleMemories("fly", initial, { query: "fly", rows: [{ id: "a" }] }), [{ id: "a" }]);
});
