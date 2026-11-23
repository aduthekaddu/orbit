import assert from "node:assert/strict";
import test from "node:test";
import { eventually } from "./eventually.mjs";

test("returns the value that satisfied the predicate once state settles later", async () => {
  let reads = 0;
  const value = await eventually(() => ++reads, (n) => n >= 3, { timeoutMs: 1_000, what: "three reads", intervalMs: 1 });
  assert.equal(value, 3);
});

test("reads an async source, and reads once when the state is already settled", async () => {
  let reads = 0;
  const value = await eventually(async () => { reads += 1; return "ready"; }, (state) => state === "ready", { timeoutMs: 50, what: "ready" });
  assert.equal(value, "ready");
  assert.equal(reads, 1);
});

test("on timeout it fails with what it waited for and the last value read", async () => {
  await assert.rejects(
    eventually(() => ({ running: ["abc123 (Up 2 seconds)"] }), (state) => state.running.length === 0, { timeoutMs: 40, what: "no sandbox container left", intervalMs: 5 }),
    (error: Error) => {
      assert.match(error.message, /Timed out after 40ms waiting for no sandbox container left/);
      assert.match(error.message, /abc123 \(Up 2 seconds\)/);
      return true;
    },
  );
});

test("an error from the read ends the wait with that error", async () => {
  const failure = new Error("docker is not running");
  await assert.rejects(eventually(() => { throw failure; }, () => true, { timeoutMs: 1_000, what: "anything" }), (error) => error === failure);
});

test("refuses a missing timeout or description", async () => {
  await assert.rejects(eventually(() => 1, () => true, { what: "x" } as never), TypeError);
  await assert.rejects(eventually(() => 1, () => true, { timeoutMs: 10, what: "" }), TypeError);
});
