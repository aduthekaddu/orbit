import assert from "node:assert/strict";
import test from "node:test";
import { thinkingLabel, thoughtLabel } from "./thought-time";

test("thinking and thought show seconds and minutes", () => {
  assert.deepEqual([-1, 400, 12_000, 110_000, 120_000].map(thoughtLabel), ["<1s", "<1s", "12s", "1m 50s", "2m"]);
  assert.deepEqual([-1, 12_000, 60_000, 110_000].map(thinkingLabel), ["0s", "12s", "1m 0s", "1m 50s"]);
});
