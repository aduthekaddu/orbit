// Each test fixes one order of Docker events with a fake Docker whose calls wait for the test, and with mocked timers.
// Nothing here talks to Docker or sleeps, so every ordering runs the same way each time.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Duplex, type Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import type Docker from "dockerode";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createRunCodeTool } from "../tools/run-code";
import { createStoppedRuns } from "../tools/stopped-runs";
import { runCode } from "./run";
import type { RunCodeOutput } from "./spec";

type Step = "create" | "attach" | "start" | "kill" | "remove";

// Docker as runCode sees it. A step in `held` waits until the test calls `release`; the others answer at once.
// The program runs until the test calls `exit`, or until `kill` (exit 137, as real Docker reports SIGKILL).
function fakeDocker(held: Step[] = []) {
  const events: string[] = [];
  const reached = new Map<Step, PromiseWithResolvers<void>>();
  const gates = new Map<Step, PromiseWithResolvers<void>>();
  const exited = Promise.withResolvers<number>();
  const connection = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const once = <T>(map: Map<Step, PromiseWithResolvers<T>>, step: Step) => {
    if (!map.has(step)) map.set(step, Promise.withResolvers<T>());
    return map.get(step)!;
  };
  const call = async (step: Step) => {
    events.push(step);
    once(reached, step).resolve();
    if (held.includes(step)) await once(gates, step).promise;
    events.push(`${step} settled`);
  };
  const container = {
    attach: async () => { await call("attach"); return connection; },
    start: async () => { await call("start"); },
    wait: async () => ({ StatusCode: await exited.promise }),
    kill: async () => {
      await call("kill");
      exited.resolve(137);
      connection.push(null);
    },
    remove: async () => { await call("remove"); },
    inspect: async () => ({ State: { OOMKilled: false } }),
  };
  const docker = {
    createContainer: async () => { await call("create"); return container; },
    modem: { demuxStream: (stream: Duplex, out: Writable) => stream.on("data", (chunk: Buffer) => out.write(chunk)) },
  };
  return {
    docker: docker as unknown as Docker,
    events,
    reached: (step: Step) => once(reached, step).promise,
    release(step: Step, error?: Error) {
      if (error) once(gates, step).reject(error);
      else once(gates, step).resolve();
    },
    print: (text: string) => connection.push(text),
    exit(code: number, { outputEnds = true } = {}) {
      exited.resolve(code);
      if (outputEnds) connection.push(null);
    },
    endOutput: () => connection.push(null),
    dropOutput: () => connection.destroy(),
  };
}

const spin = { language: "python", code: "while True: pass" } as const;

// Lets every pending promise and stream event run. The fake only uses microtasks and nextTick, so after one
// setImmediate a promise that has not settled is waiting on the test, not on time.
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function isSettled(promise: Promise<unknown>) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await drain();
  return settled;
}

async function stoppedOutput(result: Promise<RunCodeOutput>) {
  const error: unknown = await result.then(() => assert.fail("the run was not stopped"), (caught: unknown) => caught);
  assert.ok(error instanceof Error && error.name === "AbortError");
  return (error as Error & { output: RunCodeOutput }).output;
}

function useDeadlineClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return () => t.mock.timers.tick(10_000);
}

for (const pending of ["create", "attach", "start"] as const) {
  // 3c20dc5: Stop while Docker was still creating the container waited for Docker and left the container behind.
  test(`Stop while Docker ${pending} is pending returns at once and the late container is removed`, async () => {
    const fake = fakeDocker([pending]);
    const controller = new AbortController();
    const run = runCode(fake.docker, spin, controller.signal);
    await fake.reached(pending);
    controller.abort();
    assert.equal(await isSettled(run.result), true, `Stop must not wait for Docker ${pending}`);
    assert.equal((await stoppedOutput(run.result)).cancelled, true);
    assert.equal(fake.events.includes("remove"), false, `the container is removed only after ${pending} settles`);
    fake.release(pending);
    assert.equal(await run.cleanup, "removed");
    assert.equal(fake.events.at(-1), "remove settled");
    assert.ok(fake.events.indexOf(`${pending} settled`) < fake.events.indexOf("remove"));
  });
}

test("the deadline counts time spent waiting for Docker create", async (t) => {
  const passDeadline = useDeadlineClock(t);
  const fake = fakeDocker(["create"]);
  const run = runCode(fake.docker, spin);
  await fake.reached("create");
  passDeadline();
  assert.equal(await isSettled(run.result), true, "creation must count against the ten second deadline");
  assert.equal((await run.result).timedOut, true);
  fake.release("create");
  assert.equal(await run.cleanup, "removed");
});

// b7bf7d5: the deadline stayed armed while a slow removal ran, so a program that had exited was reported timed out.
test("a program that exits before its deadline is not reported timed out while removal is slow", async (t) => {
  const passDeadline = useDeadlineClock(t);
  const fake = fakeDocker(["remove"]);
  const run = runCode(fake.docker, spin);
  await fake.reached("start");
  fake.print("1\n");
  fake.exit(0);
  await fake.reached("remove");
  passDeadline();
  await drain();
  fake.release("remove");
  const result = await run.result;
  assert.equal(result.timedOut, false, "cleanup must not turn a finished program into a timeout");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "1\n");
  assert.equal(await run.cleanup, "removed");
});

// Reviewer claim (a): a Stop that arrives while removal runs after a normal exit changed the reported outcome.
test("Stop during removal after the program exited keeps the exit result", async () => {
  const fake = fakeDocker(["remove"]);
  const controller = new AbortController();
  const run = runCode(fake.docker, spin, controller.signal);
  await fake.reached("start");
  fake.print("done\n");
  fake.exit(0);
  await fake.reached("remove");
  controller.abort();
  fake.release("remove");
  const result = await run.result;
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.stdout, "done\n");
  assert.equal(fake.events.includes("kill"), false, "an exited program needs no kill");
  assert.equal(await run.cleanup, "removed");
});

// Reviewer claim (c): the deadline fired after container.wait returned but before the output ended.
test("the deadline after the program exited but before its output ended keeps the exit result", async (t) => {
  const passDeadline = useDeadlineClock(t);
  const fake = fakeDocker();
  const run = runCode(fake.docker, spin);
  await fake.reached("start");
  fake.print("late\n");
  fake.exit(0, { outputEnds: false });
  await drain();
  passDeadline();
  fake.endOutput();
  const result = await run.result;
  assert.equal(result.timedOut, false, "a program that exited before the deadline did not time out");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "late\n");
  assert.equal(await run.cleanup, "removed");
});

// Reviewer claim (b): after a stop won the race, a later Docker failure rejected with nobody listening.
for (const { name, held, fail } of [
  { name: "removal is denied", held: ["remove"] as Step[], fail: "remove" as Step },
  { name: "creation fails", held: ["create"] as Step[], fail: "create" as Step },
]) {
  test(`a Docker failure after Stop when ${name} raises no unhandled rejection`, async (t) => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    t.after(() => process.off("unhandledRejection", record));
    t.mock.method(console, "error", () => {});
    const fake = fakeDocker(held);
    const controller = new AbortController();
    const run = runCode(fake.docker, spin, controller.signal);
    await fake.reached(fail === "create" ? "create" : "start");
    controller.abort();
    await stoppedOutput(run.result);
    await fake.reached(fail);
    fake.release(fail, Object.assign(new Error("denied"), { statusCode: 403 }));
    await run.cleanup;
    await drain();
    await drain();
    assert.deepEqual(unhandled, []);
  });
}

// f43282e: a removal error after Stop replaced the stop result and left the program running.
test("Stop whose removal is denied still reports the stop, kills the program, and logs only the status code", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const fake = fakeDocker(["remove"]);
  const controller = new AbortController();
  const run = runCode(fake.docker, spin, controller.signal);
  await fake.reached("start");
  controller.abort();
  assert.equal((await stoppedOutput(run.result)).cancelled, true);
  await fake.reached("remove");
  fake.release("remove", Object.assign(new Error("private program and connection details"), { statusCode: 403 }));
  assert.equal(await run.cleanup, "failed");
  assert.ok(fake.events.indexOf("kill settled") < fake.events.indexOf("remove"), "a denied removal must not leave untrusted code running");
  assert.deepEqual(logs, [["Sandbox cleanup failed", { statusCode: 403 }]]);
});

// 246aebf: Stop threw before the collected output was read.
for (const printed of ["before-stop\n", ""]) {
  test(`Stop keeps ${printed ? "what the program printed" : "an empty result when nothing was printed"}`, async () => {
    const fake = fakeDocker();
    const controller = new AbortController();
    const run = runCode(fake.docker, spin, controller.signal);
    await fake.reached("start");
    if (printed) fake.print(printed);
    await drain();
    controller.abort();
    const output = await stoppedOutput(run.result);
    assert.deepEqual({ ...output, durationMs: 0 }, { stdout: printed, stderr: "", exitCode: null, durationMs: 0, timedOut: false, truncated: false, cancelled: true });
    assert.equal(await run.cleanup, "removed");
    assert.deepEqual(fake.events.filter((event) => event === "kill" || event === "remove"), ["kill", "remove"]);
  });
}

test("the deadline stops a running program, keeps its output, and kills it before removal", async (t) => {
  const passDeadline = useDeadlineClock(t);
  const fake = fakeDocker();
  const run = runCode(fake.docker, spin);
  await fake.reached("start");
  fake.print("before-timeout\n");
  await drain();
  passDeadline();
  const result = await run.result;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, "before-timeout\n");
  assert.equal(await run.cleanup, "removed");
  assert.deepEqual(fake.events.filter((event) => event === "kill" || event === "remove"), ["kill", "remove"]);
});

test("Stop after the Docker output connection closed still removes the container", async () => {
  const fake = fakeDocker();
  const controller = new AbortController();
  const run = runCode(fake.docker, spin, controller.signal);
  await fake.reached("start");
  fake.dropOutput();
  await drain();
  controller.abort();
  await stoppedOutput(run.result);
  assert.equal(await run.cleanup, "removed");
});

test("a finished run leaves no deadline timer and no abort listener behind", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const before = timers();
  const fake = fakeDocker();
  const controller = new AbortController();
  const run = runCode(fake.docker, spin, controller.signal);
  await fake.reached("start");
  fake.exit(0);
  assert.equal((await run.result).exitCode, 0);
  assert.equal(timers(), before, "the ten second deadline must be cleared when the run settles");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(await run.cleanup, "removed");
});

test("Stop through the AI SDK saves what the program printed", async () => {
  const fake = fakeDocker();
  const stopped = createStoppedRuns();
  const tools = { run_code: createRunCodeTool(stopped, () => fake.docker) };
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
  const stopAfterPrint = fake.reached("start").then(() => {
    fake.print("before-stop\n");
    return drain();
  }).then(() => controller.abort());
  for await (const chunk of stream as unknown as AsyncIterable<unknown>) void chunk;
  await stopAfterPrint;
  assert.equal(aborted, true);
  const part = (saved as Array<Record<string, unknown>>).find((entry) => entry.type === "tool-run_code");
  assert.equal(part?.state, "output-available");
  assert.deepEqual({ ...(part?.output as RunCodeOutput), durationMs: 0 }, { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 0, timedOut: false, truncated: false, cancelled: true });
});
