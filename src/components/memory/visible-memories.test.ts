import assert from "node:assert/strict";
import test from "node:test";
import { isMemorySearchPending, visibleMemories } from "./visible-memories";

const initial = [{ id: "a" }, { id: "b" }];

test("a search shows matches only after that search returns", () => {
  assert.deepEqual(visibleMemories("", initial, null), initial);
  assert.deepEqual(visibleMemories("fly", initial, null), []);
  assert.deepEqual(visibleMemories("fly", initial, { query: "other", rows: initial }), []);
  assert.deepEqual(visibleMemories("fly", initial, { query: "fly", rows: [{ id: "a" }] }), [{ id: "a" }]);
});

test("search stays pending until results for the trimmed query arrive", () => {
  assert.equal(isMemorySearchPending("", null), false);
  assert.equal(isMemorySearchPending("   ", null), false);
  assert.equal(isMemorySearchPending("Fly", null), true);
  assert.equal(isMemorySearchPending("Fly", { query: "other" }), true);
  assert.equal(isMemorySearchPending("Fly", { query: "Fly" }), false);
  assert.equal(isMemorySearchPending("  Fly  ", { query: "Fly" }), false);
  assert.equal(isMemorySearchPending("nomatchtoken", { query: "Fly" }), true);
  assert.equal(isMemorySearchPending("nomatchtoken", { query: "nomatchtoken" }), false);
});
