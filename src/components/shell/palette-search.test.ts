import assert from "node:assert/strict";
import test from "node:test";
import { paletteSearchNotice } from "./palette-search";

test("No results is only for an idle or finished search, never a pending, revalidating or failed one", () => {
  assert.equal(paletteSearchNotice("idle"), "empty");
  assert.equal(paletteSearchNotice("done"), "empty");
  assert.equal(paletteSearchNotice("pending"), "none");
  assert.equal(paletteSearchNotice("revalidating"), "none");
  assert.equal(paletteSearchNotice("failed"), "failed");
});
