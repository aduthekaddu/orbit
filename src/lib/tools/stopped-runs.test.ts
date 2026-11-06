import assert from "node:assert/strict";
import test from "node:test";
import { RunStopped } from "../sandbox/run";
import type { RunCodeOutput } from "../sandbox/spec";
import { createStoppedRuns } from "./stopped-runs";

const stoppedOutput: RunCodeOutput = { stdout: "x\n", stderr: "", exitCode: null, durationMs: 5, timedOut: false, truncated: false, cancelled: true };

test("a stopped run replaces its interrupted part with the output it collected", async () => {
  const stopped = createStoppedRuns();
  await assert.rejects(stopped.track("call-1", Promise.reject(new RunStopped(stoppedOutput))), { name: "AbortError" });
  const parts = [
    { type: "tool-run_code", toolCallId: "call-1", state: "input-available", input: { language: "python", code: "x" } },
    { type: "tool-run_code", toolCallId: "call-2", state: "input-available", input: { language: "python", code: "y" } },
  ];
  assert.deepEqual(await stopped.apply(parts), [{ ...parts[0], state: "output-available", output: stoppedOutput }, parts[1]]);
});

test("parts that finished on their own are left alone", async () => {
  const stopped = createStoppedRuns();
  await assert.rejects(stopped.track("call-1", Promise.reject(new RunStopped(stoppedOutput))));
  await stopped.track("call-2", Promise.resolve("done"));
  const parts = [
    { type: "tool-run_code", toolCallId: "call-1", state: "output-error", errorText: "Stopped" },
    { type: "tool-run_code", toolCallId: "call-2", state: "output-available", output: { stdout: "2\n" } },
    { type: "text", text: "hello" },
  ];
  assert.deepEqual(await stopped.apply(parts), parts);
});
