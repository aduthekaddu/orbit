import assert from "node:assert/strict";
import test from "node:test";
import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import type { Duplex, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { sandboxImages } from "./images";
import { ownedSandboxFilter, parseSandboxOwner, sandboxLabels, sandboxOwner, type SandboxOwner } from "./owner.mjs";
import { runCode } from "./run";
import type { RunCodeInput, RunCodeOutput } from "./spec";

const owner = sandboxOwner();

function isDockerStatus(error: unknown, status: number) {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status;
}

test("sandbox programs run inside real isolated containers", { timeout: 90_000 }, async (t) => {
  const docker = new Docker();
  try {
    await docker.ping();
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && ["ECONNREFUSED", "ENOENT", "EACCES", "ENOTFOUND", "EHOSTUNREACH"].includes(String(error.code)))) throw error;
    t.skip("Docker is unreachable. Start a local Docker daemon to run the sandbox escape checks.");
    return;
  }
  const ownedContainers = () => docker.listContainers({ all: true, filters: ownedSandboxFilter(owner) });
  // Every run here awaits its cleanup, so a single listing after the runs sees what they left.
  const run = async (language: RunCodeInput["language"], code: string) => {
    const started = runCode(docker, { language, code });
    const [result, cleanup] = await Promise.all([started.result, started.cleanup]);
    assert.equal(cleanup, "removed");
    return result;
  };
  const runPython = (code: string) => run("python", code);
  // Code without owner filters sees a planted container, so each one lives only inside its own subtest.
  const withPlantedContainer = async (planted: SandboxOwner, check: (container: Docker.Container) => Promise<void>) => {
    const container = await docker.createContainer({
      Image: sandboxImages.python.image,
      Cmd: ["sleep", "30"],
      Labels: { ...sandboxLabels(planted), "orbit.proof": "step-17" },
      HostConfig: { AutoRemove: true, NetworkMode: "none" },
    });
    try {
      await container.start();
      await check(container);
    } finally {
      // AutoRemove can delete the container first (404), or be deleting it as this call arrives (409).
      await container.remove({ force: true }).catch((error: unknown) => {
        if (!isDockerStatus(error, 404) && !isDockerStatus(error, 409)) throw error;
      });
    }
  };
  // A name no other run can take, so a planted container is never another run's own.
  const foreign = parseSandboxOwner(randomUUID());
  await t.test("a planted container that is already gone does not fail the check", () => withPlantedContainer(foreign, async (container) => {
    await container.kill();
    while (true) {
      try {
        await container.inspect();
      } catch (error) {
        if (isDockerStatus(error, 404)) return;
        throw error;
      }
      await delay(50);
    }
  }));
  await t.test("another run's container does not appear in this run's leftover check", () => withPlantedContainer(foreign, async () => {
    assert.deepEqual(await ownedContainers(), []);
  }));
  await t.test("a container this run left behind appears in the leftover check", () => withPlantedContainer(owner, async () => {
    assert.equal((await ownedContainers()).length, 1);
  }));
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
    const result = await run("javascript", "console.log(1+1)");
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
    assert.equal(String(await docker.ping()), "OK");
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
  await t.test("stopping a running program keeps what it printed and removes its container", async (t) => {
    const printed = Promise.withResolvers<void>();
    const demux = docker.modem.demuxStream.bind(docker.modem);
    t.mock.method(docker.modem, "demuxStream", (stream: Duplex, out: Writable, err: Writable) => {
      const write = out.write.bind(out);
      let seen = "";
      out.write = ((...args: Parameters<Writable["write"]>) => {
        seen += String(args[0]);
        if (seen.includes("before-stop\n")) printed.resolve();
        return write(...args);
      }) as Writable["write"];
      return demux(stream, out, err);
    });
    const controller = new AbortController();
    const run = runCode(docker, { language: "python", code: 'print("before-stop")\nwhile True: pass' }, controller.signal);
    await Promise.race([printed.promise, run.result.then(() => assert.fail("the program ended before it was stopped"))]);
    controller.abort();
    await assert.rejects(run.result, (error: unknown) => {
      assert.ok(error instanceof Error && error.name === "AbortError");
      const output = (error as { output?: RunCodeOutput }).output;
      assert.deepEqual({ ...output, durationMs: 0 }, { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 0, timedOut: false, truncated: false, cancelled: true });
      return true;
    });
    assert.equal(await run.cleanup, "removed");
    assert.deepEqual(await ownedContainers(), []);
  });
  // Real Docker answers 409 when asked to kill a container that never started; cleanup must still remove it.
  await t.test("Stop while Docker attach is pending removes the container that never started", async (t) => {
    const attached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const create = docker.createContainer.bind(docker);
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
      const attach = container.attach.bind(container);
      t.mock.method(container, "attach", async (attachOptions: Docker.ContainerAttachOptions) => {
        const connection = await attach(attachOptions);
        attached.resolve();
        await release.promise;
        return connection;
      });
      return container;
    });
    const controller = new AbortController();
    const run = runCode(docker, { language: "python", code: "while True: pass" }, controller.signal);
    await Promise.race([attached.promise, run.result]);
    controller.abort();
    await assert.rejects(run.result, { name: "AbortError" });
    release.resolve();
    assert.equal(await run.cleanup, "removed");
    assert.deepEqual(await ownedContainers(), []);
  });
  // f43282e: a denied removal must not leave untrusted code running.
  await t.test("Stop whose removal is denied leaves the program stopped", async (t) => {
    const waiting = Promise.withResolvers<Docker.Container>();
    const create = docker.createContainer.bind(docker);
    t.mock.method(console, "error", () => undefined);
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
      const wait = container.wait.bind(container);
      t.mock.method(container, "remove", async () => { throw Object.assign(new Error("denied"), { statusCode: 403 }); });
      t.mock.method(container, "wait", () => {
        waiting.resolve(container);
        return wait();
      });
      return container;
    });
    const controller = new AbortController();
    const run = runCode(docker, { language: "python", code: "while True: pass" }, controller.signal);
    const container = await Promise.race([waiting.promise, run.result.then(() => assert.fail("the program ended on its own"))]);
    try {
      controller.abort();
      await assert.rejects(run.result, { name: "AbortError" });
      assert.equal(await run.cleanup, "failed");
      assert.equal((await container.inspect()).State.Running, false, "a denied removal must not leave untrusted code running");
    } finally {
      await new Docker().getContainer(container.id).remove({ force: true });
    }
  });
  await t.test("no sandbox containers remain after success, errors, timeout, or cancellation", async () => {
    assert.deepEqual(await ownedContainers(), []);
  });
});
