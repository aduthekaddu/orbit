import assert from "node:assert/strict";
import test from "node:test";
import { settleInterruptedParts } from "../genui/spec";
import { STOP_MARKERS, toolCallRunEnd, toolRunEnd, type ToolRunPart, type ToolRunStatus } from "./run-status";

const toolRunStatus = (...args: Parameters<typeof toolRunEnd>) => toolRunEnd(...args).status;
const toolCallRunStatus = (props: Parameters<typeof toolCallRunEnd>[0]) => toolCallRunEnd(props).status;

test("the stop texts saved chats hold keep their values", () => {
  assert.deepEqual(STOP_MARKERS, {
    stopped: "Stopped",
    codeRunStopped: "Code run was stopped",
    searchStopped: "Search was stopped",
    cancelledOnSend: "User cancelled tool call by sending a new message.",
  });
});

test("a stopped code run hands its saved output to the card", () => {
  const output = { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 1500, timedOut: false, truncated: false, cancelled: true };
  assert.deepEqual(toolRunEnd({ state: "output-available", output }, false, "run_code"), { status: "cancelled", saved: output });
  assert.deepEqual(toolRunEnd({ state: "output-error", errorText: "Code run was stopped" }, false, "run_code"), { status: "cancelled" });
});

test("a call that threw keeps its error text and a call that returned a failure has none", () => {
  assert.deepEqual(toolRunEnd({ state: "output-error", errorText: "Invalid tool arguments" }, false, "render_ui"), { status: "failed", error: "Invalid tool arguments" });
  assert.deepEqual(toolRunEnd({ state: "output-error" }, false, "render_ui"), { status: "failed", error: "" });
  assert.deepEqual(toolRunEnd({ state: "output-available", output: { ok: false, error: "Unavailable" } }, false, "web_search"), { status: "failed" });
});

test("a consumer cannot decide the outcome from stored text", () => {
  const end = toolCallRunEnd({ toolName: "render_ui", status: { type: "complete" }, result: { error: "Stopped" }, isError: true });
  // @ts-expect-error The end has a status, not the stored errorText.
  assert.equal(end.errorText, undefined);
  // @ts-expect-error A cancelled end has no error text to match.
  if (end.status === "cancelled") assert.equal(end.error, undefined);
  // @ts-expect-error The status set is closed; there is no separate "stopped" status.
  const stopped: ToolRunStatus = "stopped";
  assert.ok(stopped);
});

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

test("a GitHub rate limit result is failed", () => {
  const result = { content: [{ type: "text", text: "API rate limit exceeded for user ID 1." }], isError: true };
  assert.equal(toolRunStatus({ state: "output-available", output: result }, false, "github_list_issues"), "failed");
  assert.equal(toolCallRunStatus({ toolName: "github_list_issues", status: { type: "complete" }, result, isError: false }), "failed");
});

test("a GitHub permission failure is failed", () => {
  const result = { content: [{ type: "text", text: "Resource not accessible by personal access token" }], isError: true };
  assert.equal(toolRunStatus({ state: "output-available", output: result }, false, "github_get_pull_request"), "failed");
  assert.equal(toolCallRunStatus({ toolName: "github_get_pull_request", status: { type: "complete" }, result, isError: false }), "failed");
});

test("a failed GitHub check stays failed", () => {
  const result = { ok: false, error: "GitHub rejected the token." };
  assert.equal(toolRunStatus({ state: "output-available", output: result }, false, "github_get_me"), "failed");
  assert.equal(toolCallRunStatus({ toolName: "github_get_me", status: { type: "complete" }, result, isError: false }), "failed");
});

test("a remember or forget result with an error is failed, and one without is succeeded", () => {
  const done = { type: "complete" } as const;
  assert.equal(toolCallRunStatus({ toolName: "remember", status: done, result: { error: "Could not save memory" }, isError: false }), "failed");
  assert.equal(toolCallRunStatus({ toolName: "forget", status: done, result: { error: "No memory with that id" }, isError: false }), "failed");
  assert.equal(toolCallRunStatus({ toolName: "remember", status: done, result: { id: "mem-1", text: "I deploy to Fly.io" }, isError: false }), "succeeded");
  assert.equal(toolCallRunStatus({ toolName: "forget", status: done, result: { id: "mem-1" }, isError: false }), "succeeded");
});

test("a tool call cancelled by a follow-up message stays cancelled, and a real error stays failed", () => {
  const cancelledOnSend = "User cancelled tool call by sending a new message.";
  const done = { type: "complete" } as const;
  for (const toolName of [undefined, "render_ui", "web_search", "run_code", "github_list_issues", "remember"] as const) {
    assert.equal(toolRunStatus({ state: "output-error", errorText: cancelledOnSend }, false, toolName), "cancelled");
    assert.equal(toolCallRunStatus({ toolName, status: done, result: { error: cancelledOnSend }, isError: true }), "cancelled");
  }
  assert.equal(toolCallRunStatus({ toolName: "render_ui", status: done, result: { error: "Invalid tool arguments" }, isError: true }), "failed");
});

test("a missing or null render_ui result matches its stopped or running state without changing other tools", () => {
  assert.equal(toolRunStatus({ state: "output-available", output: null }, false, "render_ui"), "running");
  assert.equal(toolRunStatus({ state: "output-available", output: null }, true, "render_ui"), "cancelled");
  assert.equal(toolCallRunStatus({ toolName: "render_ui", status: { type: "running" }, result: null, isError: false }), "running");
  assert.equal(toolCallRunStatus({ toolName: "render_ui", status: { type: "complete" }, result: null, isError: false }), "cancelled");
  assert.equal(toolCallRunStatus({ toolName: "render_ui", status: { type: "incomplete", reason: "error" }, result: null, isError: false }), "cancelled");
  assert.equal(toolRunStatus({ state: "output-available", output: null }, true, "web_search"), "succeeded");
  assert.equal(toolCallRunStatus({ toolName: "web_search", status: { type: "complete" }, result: null, isError: false }), "succeeded");
});
