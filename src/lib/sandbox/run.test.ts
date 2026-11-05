import assert from "node:assert/strict";
import test from "node:test";
import Docker from "dockerode";
import { Duplex } from "node:stream";
import { runCode } from "./run";

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
    const result = await runPython("x = bytearray(1024 * 1024 * 1024)");
    assert.ok(result.exitCode === 137 || result.exitCode === null);
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
    const result = await runPython("while True: pass");
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(performance.now() - started < 12_000);
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
      assert.deepEqual(await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["orbit.sandbox"] }) }), []);
    });
  }
  await t.test("cancellation waits for a pending Docker start before removal", async (t) => {
    const controller = new AbortController();
    const create = docker.createContainer.bind(docker);
    let startSettled = false;
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
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
    assert.equal(startSettled, true);
  });
  await t.test("cancelling after the Docker output connection closes still removes the container", async (t) => {
    const controller = new AbortController();
    const create = docker.createContainer.bind(docker);
    let connection: Duplex | undefined;
    let dropTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    t.mock.method(docker, "createContainer", async (options: Docker.ContainerCreateOptions) => {
      const container = await create(options);
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
      assert.deepEqual(await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["orbit.sandbox"] }) }), []);
    } finally {
      clearTimeout(deadline);
      clearTimeout(dropTimer);
      controller.abort();
      connection?.emit("end");
      await running;
    }
  });
  await t.test("no sandbox containers remain after success, errors, timeout, or cancellation", async () => {
    assert.deepEqual(await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["orbit.sandbox"] }) }), []);
  });
});
