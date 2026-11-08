import assert from "node:assert/strict";
import test from "node:test";
import { memoryWriteError } from "./save-error";

test("a memory edit shows the server's reason", () => {
  assert.equal(memoryWriteError({ error: "Memory text is longer than 500 characters" }), "Memory text is longer than 500 characters");
  assert.equal(memoryWriteError({ error: "A memory with that text already exists" }), "A memory with that text already exists");
  assert.equal(memoryWriteError({ error: "   " }), "Could not save");
  assert.equal(memoryWriteError(null), "Could not save");
});
