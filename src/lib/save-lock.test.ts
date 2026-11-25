import assert from "node:assert/strict";
import test from "node:test";
import { createSaveLock, saveLockFor } from "./save-lock";

test("a save started while another is pending is ignored", async () => {
  const run = createSaveLock();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;

  const first = run(async () => {
    calls += 1;
    await gate;
    return "first";
  });
  const second = await run(async () => {
    calls += 1;
    return "second";
  });

  assert.equal(second, false);
  assert.equal(calls, 1);

  release();
  assert.equal(await first, "first");
});

test("a save started after the first finishes runs", async () => {
  const run = createSaveLock();
  let calls = 0;

  assert.equal(await run(async () => (calls += 1)), 1);
  assert.equal(await run(async () => (calls += 1)), 2);
});

test("a failed save releases the lock", async () => {
  const run = createSaveLock();

  await assert.rejects(run(async () => {
    throw new Error("network down");
  }));
  assert.equal(await run(async () => "later"), "later");
});

test("editors for the same message share one lock, and a different message has its own", async () => {
  const first = saveLockFor("msg-1");
  const second = saveLockFor("msg-1");
  const other = saveLockFor("msg-2");
  assert.equal(first, second);
  assert.notEqual(first, other);

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = first(async () => {
    await gate;
    return "full-reply";
  });
  assert.equal(await second(async () => "code-block"), false);
  assert.equal(await other(async () => "other"), "other");
  release();
  assert.equal(await held, "full-reply");
});
