import assert from "node:assert/strict";
import test from "node:test";
import Docker from "dockerode";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { RunStopped } from "../sandbox/run";
import type { RunCodeOutput } from "../sandbox/spec";
import { waitForRunningSandbox } from "../sandbox/wait-for-running";
import { createRunCodeTool } from "./run-code";
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

test("stopping a real run_code call through the AI SDK keeps what it printed", { timeout: 60_000 }, async (t) => {
  try {
    await new Docker().listContainers();
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && ["ECONNREFUSED", "ENOENT", "EACCES", "ENOTFOUND", "EHOSTUNREACH"].includes(String(error.code)))) throw error;
    t.skip("Docker is unreachable. Start a local Docker daemon to run this check.");
    return;
  }
  const stopped = createStoppedRuns();
  const tools = { run_code: createRunCodeTool(stopped) };
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-1", toolName: "run_code", input: JSON.stringify({ language: "python", code: 'print("before-stop")\nwhile True: pass' }) },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
  const controller = new AbortController();
  const result = streamText({ model, prompt: "run it", tools, stopWhen: stepCountIs(3), abortSignal: controller.signal });
  let saved: unknown;
  let aborted = false;
  const stream = toUIMessageStream({
    stream: result.stream,
    tools,
    onError: () => "failed",
    onEnd: async ({ responseMessage, isAborted }) => {
      aborted = isAborted;
      saved = await stopped.apply(responseMessage.parts);
    },
  });
  const stopAfterStart = waitForRunningSandbox(new Docker()).then(() => delay(1000)).then(() => controller.abort());
  try {
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) void chunk;
  } finally {
    await stopAfterStart;
  }
  assert.equal(aborted, true);
  const part = (saved as Array<Record<string, unknown>>).find((entry) => entry.type === "tool-run_code");
  assert.equal(part?.state, "output-available");
  assert.deepEqual({ ...(part?.output as RunCodeOutput), durationMs: 0 }, { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 0, timedOut: false, truncated: false, cancelled: true });
});
