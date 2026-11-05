import assert from "node:assert/strict";
import test from "node:test";
import Docker from "dockerode";
import { runCode } from "./run";

test("sandbox programs run inside real isolated containers", { timeout: 90_000 }, async (t) => {
  const docker = new Docker();
  try {
    await docker.ping();
  } catch {
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
    assert.equal(await docker.ping(), "OK");
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
  await t.test("no sandbox containers remain after success, errors, timeout, or cancellation", async () => {
    assert.deepEqual(await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["orbit.sandbox"] }) }), []);
  });
});
