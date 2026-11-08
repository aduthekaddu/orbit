import assert from "node:assert/strict";
import test from "node:test";
import { settleInterruptedParts } from "../genui/spec";
import { toolCallRunStatus, toolRunStatus, type ToolRunPart, type ToolRunStatus } from "./run-status";

const cases: Array<{ name: string; part: ToolRunPart; stopped?: boolean; expected: ToolRunStatus }> = [
  { name: "streaming input", part: { state: "input-streaming" }, expected: "running" },
  { name: "complete input", part: { state: "input-available" }, expected: "running" },
  { name: "successful output", part: { state: "output-available", output: { ok: true } }, expected: "succeeded" },
  { name: "failed search output", part: { state: "output-available", output: { ok: false, error: "Unavailable" } }, expected: "failed" },
  { name: "generic output", part: { state: "output-available", output: { value: 1 } }, expected: "succeeded" },
  { name: "stored stopped call", part: { state: "output-error", errorText: "Stopped" }, expected: "cancelled" },
  { name: "tool exception", part: { state: "output-error", errorText: "Unavailable" }, expected: "failed" },
  { name: "stop during input", part: { state: "input-streaming" }, stopped: true, expected: "cancelled" },
  { name: "stop before output", part: { state: "input-available" }, stopped: true, expected: "cancelled" },
  { name: "stop after success", part: { state: "output-available", output: { ok: true } }, stopped: true, expected: "succeeded" },
  { name: "stop after failure", part: { state: "output-available", output: { ok: false } }, stopped: true, expected: "failed" },
];

for (const { name, part, stopped, expected } of cases) {
  test(name, () => assert.equal(toolRunStatus(part, stopped), expected));
}

test("a stopped call has the same status after persistence and reload", () => {
  const saved = settleInterruptedParts([{ type: "tool-web_search", toolCallId: "search-1", state: "input-available", input: { query: "orbit" } }], true);
  assert.deepEqual(saved, [{ type: "tool-web_search", toolCallId: "search-1", state: "output-error", input: { query: "orbit" }, errorText: "Stopped" }]);
  assert.equal(toolRunStatus({ state: "output-error", errorText: "Stopped" }), "cancelled");
});

test("an unresolved stopped server call is cancelled when assistant-ui reports pending tools", () => {
  assert.equal(toolCallRunStatus({ status: { type: "requires-action", reason: "tool-calls" }, result: undefined, isError: false }), "cancelled");
});

test("a pending server call remains running while its turn streams", () => {
  assert.equal(toolCallRunStatus({ status: { type: "running" }, result: undefined, isError: false }), "running");
});

test("a stored stopped call remains cancelled after assistant-ui conversion", () => {
  assert.equal(toolCallRunStatus({ status: { type: "complete" }, result: { error: "Stopped" }, isError: true }), "cancelled");
});

test("a completed result stays succeeded when the next model step is stopped", () => {
  assert.equal(toolCallRunStatus({ status: { type: "requires-action", reason: "tool-calls" }, result: { ok: true }, isError: false }), "succeeded");
});

test("an aborted search result is cancelled before and after reload", () => {
  const result = { ok: false, query: "orbit", error: "Search was stopped" };
  assert.equal(toolCallRunStatus({ status: { type: "complete" }, result, isError: false }), "cancelled");
  assert.equal(toolRunStatus({ state: "output-available", output: result }), "cancelled");
});

test("a failed code program keeps its failed status after reload", () => {
  const result = { stdout: "", stderr: "network is unreachable", exitCode: 1, durationMs: 10, timedOut: false, truncated: false };
  assert.equal(toolCallRunStatus({ toolName: "run_code", status: { type: "complete" }, result, isError: false }), "failed");
});

test("a timed out code run has a failed status", () => {
  const result = { stdout: "", stderr: "", exitCode: null, durationMs: 10000, timedOut: true, truncated: false };
  assert.equal(toolCallRunStatus({ toolName: "run_code", status: { type: "complete" }, result, isError: false }), "failed");
});


test("an aborted code run stays cancelled after persistence and reload", () => {
  const part = { state: "output-error", errorText: "Code run was stopped" } as const;
  assert.equal(toolRunStatus(part), "cancelled");
  assert.equal(toolCallRunStatus({ toolName: "run_code", status: { type: "complete" }, result: { error: part.errorText }, isError: true }), "cancelled");
});

test("a stopped code run that saved its output is cancelled, not failed", () => {
  const result = { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 1500, timedOut: false, truncated: false, cancelled: true };
  assert.equal(toolRunStatus({ state: "output-available", output: result }, false, "run_code"), "cancelled");
  assert.equal(toolCallRunStatus({ toolName: "run_code", status: { type: "complete" }, result, isError: false }), "cancelled");
});

test("a remember or forget result with an error is failed, and one without is succeeded", () => {
  const done = { type: "complete" } as const;
  assert.equal(toolCallRunStatus({ toolName: "remember", status: done, result: { error: "Could not save memory" }, isError: false }), "failed");
  assert.equal(toolCallRunStatus({ toolName: "forget", status: done, result: { error: "No memory with that id" }, isError: false }), "failed");
  assert.equal(toolCallRunStatus({ toolName: "remember", status: done, result: { id: "mem-1", text: "I deploy to Fly.io" }, isError: false }), "succeeded");
  assert.equal(toolCallRunStatus({ toolName: "forget", status: done, result: { id: "mem-1" }, isError: false }), "succeeded");
});
