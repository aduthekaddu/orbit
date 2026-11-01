import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withMigrationLock } from "./migration-lock";

const repo = process.cwd();

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `orbit-migration-lock-${prefix}-`));
}

function deadPid() {
  for (let pid = 999_999; pid > 0; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a dead pid");
}

const holderSource = `
import("./src/lib/db/migration-lock.ts").then((mod) => {
  const withMigrationLock = mod.withMigrationLock ?? mod.default.withMigrationLock;
  const holdMs = Number(process.env.HOLD_MS ?? 1000);
  withMigrationLock(() => {
    console.log("HOLD " + Date.now());
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    console.log("RELEASE " + Date.now());
  }, { dir: process.env.LOCK_DIR, timeoutMs: 20000 });
});
`;

const contenderSource = `
import("./src/lib/db/migration-lock.ts").then((mod) => {
  const withMigrationLock = mod.withMigrationLock ?? mod.default.withMigrationLock;
  withMigrationLock(() => {
    console.log("ENTER " + Date.now());
  }, { dir: process.env.LOCK_DIR, timeoutMs: 20000 });
  console.log("EXIT " + Date.now());
});
`;

const racerSource = `
import fs from "node:fs";
import("./src/lib/db/migration-lock.ts").then((mod) => {
  const withMigrationLock = mod.withMigrationLock ?? mod.default.withMigrationLock;
  withMigrationLock(() => {
    fs.appendFileSync(process.env.LOG_PATH, "enter " + process.pid + "\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    fs.appendFileSync(process.env.LOG_PATH, "exit " + process.pid + "\\n");
  }, { dir: process.env.LOCK_DIR, timeoutMs: 20000 });
});
`;

function start(source: string, env: Record<string, string>) {
  const proc = spawn(process.execPath, ["--import", "tsx", "-e", source], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`child timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
  return { output: () => `${stdout}\n${stderr}`, done };
}

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readLock(lockPath: string) {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch {
    return "";
  }
}

test("a directory at the lock path fails fast with a clear error", () => {
  const dir = tempDir("directory");
  const lockPath = path.join(dir, ".migrate.lock");
  fs.mkdirSync(lockPath);
  let entered = false;
  const started = Date.now();

  assert.throws(
    () =>
      withMigrationLock(
        () => {
          entered = true;
        },
        { dir, timeoutMs: 60_000 },
      ),
    /database migration lock .*EISDIR/,
  );
  assert.equal(entered, false);
  assert.ok(Date.now() - started < 2_000, `blocked for ${Date.now() - started}ms`);
});

test(
  "a lock that cannot be claimed fails fast instead of spinning",
  { skip: process.getuid?.() === 0 },
  () => {
    const dir = tempDir("unwritable");
    fs.writeFileSync(path.join(dir, ".migrate.lock"), `${deadPid()}:${randomUUID()}`);
    fs.chmodSync(dir, 0o500);
    const started = Date.now();
    try {
      assert.throws(
        () => withMigrationLock(() => undefined, { dir, timeoutMs: 60_000 }),
        /database migration lock claim .*EACCES/,
      );
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.ok(Date.now() - started < 2_000, `blocked for ${Date.now() - started}ms`);
  },
);

test("a lock left by a dead process is taken over and released", () => {
  const dir = tempDir("dead");
  const lockPath = path.join(dir, ".migrate.lock");
  fs.writeFileSync(lockPath, `${deadPid()}:${randomUUID()}`);

  const result = withMigrationLock(() => "migrated", { dir, timeoutMs: 5_000 });

  assert.equal(result, "migrated");
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(path.join(dir, ".migrate.lock.claim")), false);
});

test("a live lock times out at the deadline instead of entering", () => {
  const dir = tempDir("deadline");
  const lockPath = path.join(dir, ".migrate.lock");
  const token = `${process.pid}:${randomUUID()}`;
  fs.writeFileSync(lockPath, token);
  let entered = false;
  const started = Date.now();

  assert.throws(
    () =>
      withMigrationLock(
        () => {
          entered = true;
        },
        { dir, timeoutMs: 200 },
      ),
    /Timed out after 200ms/,
  );
  assert.equal(entered, false);
  assert.ok(Date.now() - started < 5_000, `blocked for ${Date.now() - started}ms`);
  assert.equal(readLock(lockPath), token);
});

test("a live lock is not taken over, however old its mtime", { timeout: 30_000 }, async () => {
  const dir = tempDir("live");
  const lockPath = path.join(dir, ".migrate.lock");
  const holder = start(holderSource, { LOCK_DIR: dir, HOLD_MS: "1200" });
  await waitFor(() => /^\d+:[0-9a-f-]{36}$/.test(readLock(lockPath)), "the holder to write its lock");

  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockPath, old, old);
  const contender = start(contenderSource, { LOCK_DIR: dir });

  const held = await holder.done;
  const waited = await contender.done;
  assert.equal(held.code, 0, held.stderr);
  assert.equal(waited.code, 0, waited.stderr);
  const released = Number(/RELEASE (\d+)/.exec(held.stdout)?.[1]);
  const entered = Number(/ENTER (\d+)/.exec(waited.stdout)?.[1]);
  assert.ok(entered >= released, `contender entered at ${entered} before the holder released at ${released}`);
});

test("release leaves a lock whose token it does not own", { timeout: 30_000 }, async () => {
  const dir = tempDir("release");
  const lockPath = path.join(dir, ".migrate.lock");
  const holder = start(holderSource, { LOCK_DIR: dir, HOLD_MS: "900" });
  await waitFor(() => holder.output().includes("HOLD"), "the holder to enter");

  const successor = `${process.pid}:${randomUUID()}`;
  fs.writeFileSync(lockPath, successor);
  const held = await holder.done;

  assert.equal(held.code, 0, held.stderr);
  assert.equal(readLock(lockPath), successor);
});

test("only one of six processes enters at a time when they race for a stale lock", { timeout: 40_000 }, async () => {
  const dir = tempDir("race");
  const lockPath = path.join(dir, ".migrate.lock");
  const logPath = path.join(dir, "sections.log");
  fs.writeFileSync(lockPath, `${deadPid()}:${randomUUID()}`);

  const racers = Array.from({ length: 6 }, () => start(racerSource, { LOCK_DIR: dir, LOG_PATH: logPath }));
  const results = await Promise.all(racers.map((racer) => racer.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);

  const events = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(" ")[0]);
  assert.equal(events.filter((event) => event === "enter").length, 6);
  assert.equal(events.filter((event) => event === "exit").length, 6);
  const expected = events.flatMap((_, index) => [index % 2 === 0 ? "enter" : "exit"]);
  assert.deepEqual(events, expected, `two processes were inside the lock at once:\n${events.join("\n")}`);
  assert.equal(fs.existsSync(lockPath), false);
});
