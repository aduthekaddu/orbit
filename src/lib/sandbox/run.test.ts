import assert from "node:assert/strict";
import test from "node:test";
import Docker from "dockerode";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { format } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createRunCodeTool } from "../tools/run-code";
import { createStoppedRuns } from "../tools/stopped-runs";
import { runCode, killedForMemory } from "./run";
import { removeStaleSandboxes } from "./sweep";
import { waitForRunningSandbox } from "./wait-for-running";
import { containerSpec, type RunCodeInput, type RunCodeOutput } from "./spec";

// The child prints its container's id, then passes on the program's own stdout.
function runCodeInChild(input: RunCodeInput): ChildProcess {
  const script = `
    const { Writable } = await import("node:stream");
    const { default: Docker } = await import("dockerode");
    const { runCode } = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
    const docker = new Docker();
    const create = docker.createContainer.bind(docker);
    docker.createContainer = async (options) => {
      const container = await create(options);
      process.stdout.write("container " + container.id + "\\n");
      return container;
    };
    const demux = docker.modem.demuxStream.bind(docker.modem);
    docker.modem.demuxStream = (stream, stdout, stderr) => demux(stream, new Writable({
      write(chunk, encoding, done) {
        process.stdout.write(chunk);
        stdout.write(chunk, done);
      },
    }), stderr);
    await runCode(docker, ${JSON.stringify(input)});
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "inherit"] });
}

function loopingContainerId(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let printed = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
      const id = /^container ([0-9a-f]{64})$/m.exec(printed)?.[1];
      if (id && /^looping$/m.test(printed)) resolve(id);
    });
    child.once("exit", (code, signal) => reject(new Error(`the child exited before its program started looping (${code ?? signal})`)));
  });
}

async function inspectUntil(container: Docker.Container, done: (state: Docker.ContainerInspectInfo["State"]) => boolean, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  let state = (await container.inspect()).State;
  while (!done(state) && performance.now() < deadline) {
    await delay(100);
    state = (await container.inspect()).State;
  }
  return state;
}

function isNotFound(error: unknown) {
  return error !== null && typeof error === "object" && "statusCode" in error && error.statusCode === 404;
}

async function waitForNoContainers(docker: Docker) {
  const deadline = performance.now() + 2000;
  while (true) {
    const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["orbit.sandbox"] }) });
    if (containers.length === 0 || performance.now() >= deadline) {
      assert.deepEqual(containers, []);
      return;
    }
    await delay(50);
  }
}

test("sandbox programs run inside real isolated containers", { timeout: 90_000 }, async (t) => {
  const docker = new Docker();
  try {
    await docker.listContainers();
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && ["ECONNREFUSED", "ENOENT", "EACCES", "ENOTFOUND", "EHOSTUNREACH"].includes(String(error.code)))) throw error;
    t.skip("Docker is unreachable. Start a local Docker daemon to run the sandbox escape checks.");
    return;
  }
  const runPython = (code: string) => runCode(docker, { language: "python", code });
  await t.test("Python print(1+1) prints 2 and exits 0", async () => {
    const result = await runPython("print(1+1)");
    assert.equal(result.stdout, "2\n");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.ok(result.durationMs > 0);
  });
  await t.test("JavaScript source arrives through stdin and can print", async () => {
    const result = await runCode(docker, { language: "javascript", code: "console.log(1+1)" });
    assert.equal(result.stdout, "2\n");
    assert.equal(result.exitCode, 0);
  });
  await t.test("outbound HTTP fails with a network error", async () => {
    const result = await runPython('import urllib.request\nurllib.request.urlopen("http://1.1.1.1", timeout=2)');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stderr, /Network is unreachable|network is unreachable/);
  });
  await t.test("writing /etc/x fails on the read-only root filesystem", async () => {
    const result = await runPython('open("/etc/x", "w").write("escape")');
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Read-only file system/);
  });
  await t.test("the program runs as uid 65534", async () => {
    const result = await runPython("import os; print(os.getuid())");
    assert.equal(result.stdout, "65534\n");
    assert.equal(result.exitCode, 0);
  });
  await t.test("allocating 1 GiB is killed by the memory limit", async () => {
    const result = await runPython('print("before-oom")\nx = bytearray(1024 * 1024 * 1024)');
    assert.ok(result.exitCode === 137 || result.exitCode === null);
    assert.equal(result.oomKilled, true);
    assert.equal(result.stdout, "before-oom\n");
  });
  await t.test("a program that exits 137 on its own is not marked as a memory kill", async () => {
    const result = await runPython("import sys\nsys.exit(137)");
    assert.equal(result.exitCode, 137);
    assert.equal(result.oomKilled, undefined);
    assert.equal(result.timedOut, false);
  });
  await t.test("a fork loop reaches the process limit while Docker stays responsive", async () => {
    const result = await runPython(`import os, time
children = []
try:
    for _ in range(100):
        pid = os.fork()
        if pid == 0:
            time.sleep(8)
            os._exit(0)
        children.append(pid)
except OSError as error:
    print(error, flush=True)
finally:
    for pid in children:
        os.kill(pid, 9)
    for pid in children:
        os.waitpid(pid, 0)
`);
    assert.match(result.stdout, /Resource temporarily unavailable/);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.ok(Array.isArray(await docker.listContainers()));
  });
  await t.test("an infinite loop times out within 12 seconds", async () => {
    const started = performance.now();
    const result = await runPython('print("before-timeout")\nwhile True: pass');
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(performance.now() - started < 12_000);
    assert.equal(result.stdout, "before-timeout\n");
  });
  await t.test("stdout and stderr each stop at 64 KiB without blocking the program", async () => {
    const result = await runPython('import sys\nsys.stdout.write("x" * 200000)\nsys.stderr.write("y" * 200000)');
    assert.equal(Buffer.byteLength(result.stdout), 65536);
    assert.equal(Buffer.byteLength(result.stderr), 65536);
    assert.equal(result.truncated, true);
    assert.equal(result.exitCode, 0);
  });
  await t.test("partial UTF-8 and invalid bytes cannot expand output past 64 KiB", async () => {
    const result = await runPython('import os\nos.write(1, ("€" * 30000).encode())\nos.write(2, b"\\xff" * 100000)');
    assert.ok(Buffer.byteLength(result.stdout) <= 65536);
    assert.ok(Buffer.byteLength(result.stderr) <= 65536);
    assert.ok(!result.stdout.endsWith("\uFFFD"));
    assert.equal(result.truncated, true);
    assert.equal(result.exitCode, 0);
  });
  await t.test("a program error returns stderr and its exit code", async () => {
    const result = await runPython('raise ValueError("program failed")');
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /ValueError: program failed/);
  });
  await t.test("an incomplete UTF-8 character at the output limit is marked truncated", async () => {
    const result = await runPython('import os\nos.write(1, b"x" * 65534 + b"\\xe2\\x82")');
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout), 65534);
    assert.equal(result.truncated, true);
  });
  await t.test("an incomplete UTF-8 character below the limit is flushed as replacement text", async () => {
    const result = await runPython('import os\nos.write(1, b"x\\xe2\\x82")');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "x\uFFFD");
    assert.equal(result.truncated, false);
  });
  await t.test("a fresh container cannot read the prior run's tmp file", async () => {
    assert.equal((await runPython('open("/tmp/orbit-test", "w").write("private")')).exitCode, 0);
    const result = await runPython('open("/tmp/orbit-test").read()');
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No such file or directory/);
  });
  await t.test("cancelling a running program kills and removes its container", async () => {
    const controller = new AbortController();
    const running = runCode(docker, { language: "python", code: "while True: pass" }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await assert.rejects(running, { name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
  });
  for (const { name, code, printed } of [
    { name: "stopping a program keeps what it already printed", code: 'print("before-stop")\nwhile True: pass', printed: "before-stop\n" },
    { name: "stopping a program that printed nothing keeps an empty result", code: "while True: pass", printed: "" },
  ]) {
    await t.test(name, async () => {
      const controller = new AbortController();
      const running = runCode(docker, { language: "python", code }, controller.signal);
      const stopped = waitForRunningSandbox(docker).then(() => delay(1000)).then(() => controller.abort());
      try {
        await assert.rejects(running, (error: unknown) => {
          assert.ok(error instanceof Error && error.name === "AbortError");
          const output = (error as { output?: Record<string, unknown> }).output;
          assert.ok(output, "the stop error must carry the output collected so far");
          assert.equal(output.stdout, printed);
          assert.equal(output.stderr, "");
          assert.equal(output.exitCode, null);
          assert.equal(output.timedOut, false);
          assert.equal(output.cancelled, true);
          return true;
        });
      } finally {
        await stopped;
      }
    });
  }
  await t.test("stopping a run_code call through the AI SDK keeps what it printed", async () => {
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
    const stopAfterStart = waitForRunningSandbox(docker).then(() => delay(1000)).then(() => controller.abort());
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
  await t.test("slow cleanup preserves a program that finished before its deadline", async (t) => {
    const removing = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    const create = docker.createContainer.bind(docker);
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
      const remove = container.remove.bind(container);
      t.mock.method(container, "remove", async (options: Docker.ContainerRemoveOptions) => {
        removing.resolve();
        await released.promise;
        const result = await remove(options);
        removed.resolve();
        return result;
      });
      return container;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const running = runPython("print(1)");
    try {
      await removing.promise;
      t.mock.timers.tick(10_000);
      released.resolve();
      const result = await running;
      assert.equal(result.timedOut, false, "cleanup must not turn a finished program into a timeout");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "1\n");
    } finally {
      t.mock.timers.reset();
      released.resolve();
      await running;
      await removed.promise;
    }
  });
  await t.test("the ten second deadline includes pending Docker creation", async (t) => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    const create = docker.createContainer.bind(docker);
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
      const remove = container.remove.bind(container);
      t.mock.method(container, "remove", async (options: Docker.ContainerRemoveOptions) => {
        const result = await remove(options);
        removed.resolve();
        return result;
      });
      entered.resolve();
      await released.promise;
      return container;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const running = runPython("print(1)");
    try {
      await entered.promise;
      t.mock.timers.tick(10_000);
      const result = await Promise.race([
        running,
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      assert.notEqual(result, "pending", "creation must count against the ten second deadline");
      assert.ok(result !== "pending" && result.timedOut);
    } finally {
      t.mock.timers.reset();
      released.resolve();
      await running;
      await removed.promise;
    }
  });
  for (const pending of ["create", "attach", "start"]) {
    await t.test(`cancellation returns while Docker ${pending} is pending and removes its late container`, async (t) => {
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const removed = Promise.withResolvers<void>();
      const create = docker.createContainer.bind(docker);
      t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
        const container = await create(options);
        const remove = container.remove.bind(container);
        t.mock.method(container, "remove", async (options: Docker.ContainerRemoveOptions) => {
          const result = await remove(options);
          removed.resolve();
          return result;
        });
        if (pending === "create") {
          entered.resolve();
          await released.promise;
        } else if (pending === "attach") {
          const attach = container.attach.bind(container);
          t.mock.method(container, "attach", async (options: Docker.ContainerAttachOptions) => {
            const connection = await attach(options);
            entered.resolve();
            await released.promise;
            return connection;
          });
        } else {
          const start = container.start.bind(container);
          t.mock.method(container, "start", async () => {
            const result = await start();
            entered.resolve();
            await released.promise;
            return result;
          });
        }
        return container;
      });
      const running = runCode(docker, { language: "python", code: "while True: pass" }, controller.signal)
        .then(() => null, (error: unknown) => error);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await entered.promise;
        controller.abort();
        const result = await Promise.race([
          running,
          new Promise<"pending">((resolve) => { deadline = setTimeout(() => resolve("pending"), 200); }),
        ]);
        assert.notEqual(result, "pending", `cancellation must not wait for Docker ${pending}`);
        assert.ok(result instanceof Error && result.name === "AbortError");
      } finally {
        clearTimeout(deadline);
        released.resolve();
        await running;
        await removed.promise;
      }
      await waitForNoContainers(docker);
    });
  }
  await t.test("cancellation removes a late-started container only after start settles", async (t) => {
    const controller = new AbortController();
    const create = docker.createContainer.bind(docker);
    let startSettled = false;
    const removed = Promise.withResolvers<void>();
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
      const remove = container.remove.bind(container);
      t.mock.method(container, "remove", async (options: Docker.ContainerRemoveOptions) => {
        assert.equal(startSettled, true);
        const result = await remove(options);
        removed.resolve();
        return result;
      });
      const start = container.start.bind(container);
      t.mock.method(container, "start", async () => {
        await start();
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 500));
        startSettled = true;
      });
      return container;
    });
    await assert.rejects(runCode(docker, { language: "python", code: "while True: pass" }, controller.signal), { name: "AbortError" });
    await removed.promise;
    assert.equal(startSettled, true);
  });
  await t.test("cancelling after the Docker output connection closes still removes the container", async (t) => {
    const controller = new AbortController();
    const create = docker.createContainer.bind(docker);
    let connection: Duplex | undefined;
    let dropTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const removed = Promise.withResolvers<void>();
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
      const remove = container.remove.bind(container);
      t.mock.method(container, "remove", async (options: Docker.ContainerRemoveOptions) => {
        const result = await remove(options);
        removed.resolve();
        return result;
      });
      const attach = container.attach.bind(container);
      const wait = container.wait.bind(container);
      t.mock.method(container, "attach", async (options: Docker.ContainerAttachOptions) => {
        const stream = await attach(options);
        assert.ok(stream instanceof Duplex);
        connection = stream;
        return stream;
      });
      t.mock.method(container, "wait", async () => {
        if (!dropTimer) dropTimer = setTimeout(() => {
          connection?.destroy();
          controller.abort();
        }, 50);
        return wait();
      });
      return container;
    });
    const running = runCode(docker, { language: "python", code: "while True: pass" }, controller.signal)
      .then(() => null, (error: unknown) => error);
    try {
      const result = await Promise.race([
        running,
        new Promise<"pending">((resolve) => { deadline = setTimeout(() => resolve("pending"), 2000); }),
      ]);
      assert.notEqual(result, "pending", "a dropped output connection must not block cancellation cleanup");
      assert.ok(result instanceof Error && result.name === "AbortError");
      await removed.promise;
      await waitForNoContainers(docker);
    } finally {
      clearTimeout(deadline);
      clearTimeout(dropTimer);
      controller.abort();
      connection?.emit("end");
      await running;
    }
  });
  await t.test("cancellation stops the program and logs safely when container removal is denied", async (t) => {
    const controller = new AbortController();
    const executing = Promise.withResolvers<void>();
    const removalAttempted = Promise.withResolvers<void>();
    const logs: unknown[][] = [];
    const create = docker.createContainer.bind(docker);
    let container: Docker.Container | undefined;
    let cleanup: (() => Promise<unknown>) | undefined;
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      container = await create(options);
      const remove = container.remove.bind(container);
      const wait = container.wait.bind(container);
      cleanup = () => remove({ force: true });
      t.mock.method(container, "remove", async () => {
        removalAttempted.resolve();
        throw Object.assign(new Error("private program and connection details"), { statusCode: 403 });
      });
      t.mock.method(container, "wait", () => {
        executing.resolve();
        return wait();
      });
      return container;
    });
    const running = runCode(docker, { language: "python", code: "while True: pass" }, controller.signal)
      .then(() => null, (error: unknown) => error);
    try {
      await executing.promise;
      controller.abort();
      const result = await running;
      assert.ok(result instanceof Error && result.name === "AbortError");
      await removalAttempted.promise;
      assert.ok(container);
      assert.equal((await container.inspect()).State.Running, false, "a denied removal must not leave untrusted code running");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(logs, [["Sandbox cleanup failed", { statusCode: 403 }]]);
    } finally {
      controller.abort();
      await running;
      await cleanup?.();
    }
  });
  await t.test("a container stops at its own ten-second limit after the process running it is killed", async () => {
    await Promise.all(([
      { language: "python", code: 'print("looping")\nwhile True: pass' },
      { language: "javascript", code: 'console.log("looping"); for (;;) {}' },
    ] as const).map(async (input) => {
      const child = runCodeInChild(input);
      const childExited = new Promise((resolve) => child.once("exit", resolve));
      let id: string | undefined;
      try {
        id = await loopingContainerId(child);
        const container = docker.getContainer(id);
        child.kill("SIGKILL");
        await childExited;
        const started = Date.parse((await container.inspect()).State.StartedAt);
        const state = await inspectUntil(container, (state) => !state.Running, started + 15_000 - Date.now());
        assert.equal(state.Status, "exited", `the ${input.language} container must stop after the process that ran it is killed`);
        assert.equal(state.ExitCode, 137);
        assert.ok(Date.parse(state.FinishedAt) - started < 12_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await childExited;
        if (id) await docker.getContainer(id).remove({ force: true });
      }
    }));
  });
  await t.test("a run reports a timeout when its container stops itself before Orbit's timer fires", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const running = runPython('print("before-timeout")\nwhile True: pass');
    // The mocked clock stays frozen so Orbit's own timer cannot fire, and the OOM flag poll
    // sleeps on that clock. Watch for the container's own limit with no mocked sleep, then
    // move mock time only after the program has stopped, so the poll can give up without
    // Orbit's timer ever firing.
    const programStopped = (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const containers = await docker.listContainers({ filters: { label: ["orbit.sandbox=true"], status: ["running"] } });
        if (containers.length > 0) {
          await docker.getContainer(containers[0]!.Id).wait();
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("the program's container never started");
    })();
    let ticker: ReturnType<typeof setInterval> | undefined;
    let guard: ReturnType<typeof setInterval> | undefined;
    try {
      const result = await Promise.race([
        programStopped.then(() => {
          ticker = setInterval(() => t.mock.timers.tick(50), 50);
          return running;
        }),
        new Promise<"pending">((resolve) => { guard = setInterval(() => resolve("pending"), 15_000); }),
      ]);
      assert.ok(result !== "pending", "the container must stop at its own ten-second limit");
      assert.deepEqual({ ...result, durationMs: 0 }, { stdout: "before-timeout\n", stderr: "", exitCode: null, durationMs: 0, timedOut: true, truncated: false });
    } finally {
      clearInterval(guard);
      clearInterval(ticker);
      t.mock.timers.tick(10_000);
      t.mock.timers.reset();
      await running;
    }
  });
  await t.test("the sweep keeps sandbox containers younger than a minute and removes older ones in any state", async (t) => {
    // Other Orbit servers can share this Docker host, so every listing is narrowed to the containers this test makes.
    const owner = randomUUID();
    const list = docker.listContainers.bind(docker);
    t.mock.method(docker, "listContainers", (options: { filters: { label: string[] } }) =>
      list({ ...options, filters: { ...options.filters, label: [...options.filters.label, `orbit.test=${owner}`] } }));
    const removals: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { removals.push(format(...args)); });
    const spec = containerSpec({ language: "python", code: "" });
    const labels = { ...spec.Labels, "orbit.test": owner };
    const made: Record<string, Docker.Container> = {};
    const states = async () => Object.fromEntries(await Promise.all(Object.entries(made).map(async ([name, container]) => {
      try {
        return [name, (await container.inspect()).State.Status];
      } catch (error) {
        if (isNotFound(error)) return [name, "removed"];
        throw error;
      }
    })));
    try {
      made.created = await docker.createContainer({ ...spec, Labels: labels });
      made.exited = await docker.createContainer({ ...spec, Labels: labels, Cmd: ["true"] });
      made.running = await docker.createContainer({ ...spec, Labels: labels, Cmd: ["sleep", "60"] });
      made.unlabeled = await docker.createContainer({ Image: spec.Image, Cmd: ["true"], Labels: { "orbit.test": owner } });
      await made.exited.start();
      await made.exited.wait();
      await made.running.start();
      await removeStaleSandboxes(docker, Date.now() + 5_000);
      assert.deepEqual(await states(), { created: "created", exited: "exited", running: "running", unlabeled: "created" }, "a young container may belong to a live run");
      assert.equal(removals.length, 0, "a container the sweep keeps is not logged as removed");
      await removeStaleSandboxes(docker, Date.now() + 60_000);
      assert.deepEqual(await states(), { created: "removed", exited: "removed", running: "removed", unlabeled: "created" });
      assert.deepEqual(
        [...removals].sort(),
        ["created", "exited", "running"].map((state) => `Sandbox sweep removed a stale container id=${made[state]!.id} state=${state}`).sort(),
      );
    } finally {
      for (const container of Object.values(made)) {
        await container.remove({ force: true }).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
      }
    }
  });
  await t.test("no sandbox containers remain after success, errors, timeout, or cancellation", async () => {
    await waitForNoContainers(docker);
  });
});

// Docker records the OOM flag from the container's OOM event, which can arrive after the exit
// event that container.wait() resolves on, so the first inspect can see the flag unset.
test("a memory kill is confirmed by re-reading Docker's OOM flag", async (t) => {
  await t.test("a late OOM flag still confirms the memory kill", async () => {
    let inspections = 0;
    const container = {
      inspect: async () => {
        inspections += 1;
        return { State: { OOMKilled: inspections > 2 } };
      },
    } as unknown as Pick<Docker.Container, "inspect">;
    assert.equal(await killedForMemory(container), true);
    assert.ok(inspections > 1, "the flag must be re-read while Docker has not confirmed the kill yet");
  });
  await t.test("a container that never reports the OOM flag is not a confirmed memory kill", async () => {
    const container = { inspect: async () => ({ State: { OOMKilled: false } }) } as unknown as Pick<Docker.Container, "inspect">;
    assert.equal(await killedForMemory(container), false);
  });
});
