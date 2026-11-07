import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { hasOpenCodeRun, restoreStoppedRuns } from "./chat-stopped-runs";

const stoppedOutput = { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 1300, timedOut: false, truncated: false, cancelled: true };
const input = { language: "python", code: "print('before-stop')\nwhile True: pass" };
const message = (id: string, role: UIMessage["role"], parts: unknown[]) => ({ id, role, parts }) as UIMessage;
const openRun = (toolCallId: string) => ({ type: "tool-run_code", toolCallId, state: "input-available", input });
const savedRun = (toolCallId: string, output: unknown = stoppedOutput) => ({ type: "tool-run_code", toolCallId, state: "output-available", input, output });

test("a code run without a result marks the reply as stopped mid-run", () => {
  assert.equal(hasOpenCodeRun(message("a", "assistant", [{ type: "text", text: "hi" }, openRun("call-1")])), true);
  assert.equal(hasOpenCodeRun(message("a", "assistant", [savedRun("call-1")])), false);
  assert.equal(hasOpenCodeRun(message("a", "assistant", [{ type: "text", text: "hi" }])), false);
});

test("the saved result goes onto the live run and nothing else changes", () => {
  const text = { type: "text", text: "partial reply" };
  const user = message("u", "user", [{ type: "text", text: "run it" }]);
  const live = [user, message("a", "assistant", [text, openRun("call-1")])];
  const next = restoreStoppedRuns(live, message("a", "assistant", [{ type: "text", text: "saved text" }, savedRun("call-1")]));
  assert.notEqual(next, live);
  assert.equal(next[0], user);
  const parts = next[1].parts as unknown as Record<string, unknown>[];
  assert.equal(parts[0], text);
  assert.deepEqual(parts[1], { type: "tool-run_code", toolCallId: "call-1", state: "output-available", input, output: stoppedOutput });
});

test("only the stopped run gets a result when a reply has two runs", () => {
  const live = [message("a", "assistant", [savedRun("done", { ...stoppedOutput, cancelled: undefined, exitCode: 0 }), openRun("call-2")])];
  const next = restoreStoppedRuns(live, message("a", "assistant", [savedRun("done"), savedRun("call-2")]));
  const parts = next[0].parts as unknown as Record<string, unknown>[];
  assert.equal(parts[0], live[0].parts[0]);
  assert.deepEqual((parts[1] as { output: unknown }).output, stoppedOutput);
});

test("a saved result that is not a stopped run is left out", () => {
  const live = [message("a", "assistant", [openRun("call-1")])];
  assert.equal(restoreStoppedRuns(live, message("a", "assistant", [savedRun("call-1", { ...stoppedOutput, cancelled: undefined, exitCode: 0 })])), live);
  assert.equal(restoreStoppedRuns(live, message("a", "assistant", [{ ...openRun("call-1"), state: "output-error", errorText: "Stopped" }])), live);
});

test("another reply, another call id, or a saved copy that is missing leaves the live messages as they are", () => {
  const live = [message("a", "assistant", [openRun("call-1")]), message("b", "assistant", [openRun("call-1")])];
  assert.equal(restoreStoppedRuns(live, message("c", "assistant", [savedRun("call-1")])), live);
  assert.equal(restoreStoppedRuns(live, message("a", "assistant", [savedRun("call-9")])), live);
  const next = restoreStoppedRuns(live, message("a", "assistant", [savedRun("call-1")]));
  assert.equal(next[1], live[1]);
});

test("a run that assistant-ui closed when a new message was sent gets the saved result", () => {
  const closed = { ...openRun("call-1"), state: "output-error", errorText: "User cancelled tool call by sending a new message." };
  const next = restoreStoppedRuns([message("a", "assistant", [closed])], message("a", "assistant", [savedRun("call-1")]));
  assert.deepEqual(next[0].parts[0], savedRun("call-1"));
});

test("a run that already has its result is not touched", () => {
  const finished = { ...savedRun("call-1"), output: { ...stoppedOutput, stdout: "newer\n" } };
  const live = [message("a", "assistant", [finished])];
  assert.equal(restoreStoppedRuns(live, message("a", "assistant", [savedRun("call-1")])), live);
});
