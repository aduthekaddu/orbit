import assert from "node:assert/strict";
import test from "node:test";
import { settleInterruptedParts } from "../genui/spec";
import { toolRunStatus, type ToolRunPart, type ToolRunStatus } from "./run-status";

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
