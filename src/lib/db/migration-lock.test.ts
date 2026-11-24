import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { eventually } from "../eventually.mjs";
import { withMigrationLock } from "./migration-lock";

const repo = process.cwd();

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-migration-lock-${prefix}-`));
  dirs.push(dir);
  return dir;
}

const holderSource = `
import("./src/lib/db/migration-lock.ts").then((mod) => {
  const withMigrationLock = mod.withMigrationLock ?? mod.default.withMigrationLock;
  withMigrationLock(() => {
    console.log("HOLD " + Date.now());
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HOLD_MS ?? 1000));
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

const importDbSource = `
import("./src/lib/db/index.ts").then(
  () => console.log("READY"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
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
  return { proc, output: () => `${stdout}\n${stderr}`, done };
}

async function waitForHolder(holder: { output: () => string }) {
  await eventually(() => holder.output(), (output) => output.includes("HOLD"), { timeoutMs: 10_000, what: "the holder to enter the lock", intervalMs: 20 });
}

test("two processes serialize and the second enters after the first releases", { timeout: 30_000 }, async () => {
  const dir = tempDir("serialize");
  const holder = start(holderSource, { LOCK_DIR: dir, HOLD_MS: "900" });
  await waitForHolder(holder);
  const contender = start(contenderSource, { LOCK_DIR: dir });

  const held = await holder.done;
  const waited = await contender.done;
  assert.equal(held.code, 0, held.stderr);
  assert.equal(waited.code, 0, waited.stderr);
  const released = Number(/RELEASE (\d+)/.exec(held.stdout)?.[1]);
  const entered = Number(/ENTER (\d+)/.exec(waited.stdout)?.[1]);
  assert.ok(entered >= released, `contender entered at ${entered} before the holder released at ${released}`);
});

test("a SIGKILLed holder releases the lock within a short time", { timeout: 30_000 }, async () => {
  const dir = tempDir("kill");
  const holder = start(holderSource, { LOCK_DIR: dir, HOLD_MS: "30000" });
  await waitForHolder(holder);

  const killedAt = Date.now();
  holder.proc.kill("SIGKILL");
  await holder.done;

  const result = withMigrationLock(() => "recovered", { dir, timeoutMs: 2_000 });
  const elapsed = Date.now() - killedAt;

  assert.equal(result, "recovered");
  assert.ok(elapsed < 2_000, `the next owner waited ${elapsed}ms for a killed holder`);
});

test("a live holder makes a 200ms waiter throw a clear timeout", { timeout: 30_000 }, async () => {
  const dir = tempDir("timeout");
  const holder = start(holderSource, { LOCK_DIR: dir, HOLD_MS: "1500" });
  await waitForHolder(holder);

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
    /Timed out after 200ms waiting for the database migration lock at .*\.migrate\.lock\.db/,
  );
  assert.equal(entered, false);
  assert.ok(Date.now() - started < 5_000);

  const held = await holder.done;
  assert.equal(held.code, 0, held.stderr);
});

test("a stale .migrate.lock file with a live pid does not block", () => {
  const dir = tempDir("legacy");
  const legacyLock = path.join(dir, ".migrate.lock");
  const token = `${process.pid}:${randomUUID()}`;
  fs.writeFileSync(legacyLock, token);

  let entered = false;
  withMigrationLock(
    () => {
      entered = true;
    },
    { dir, timeoutMs: 300 },
  );

  assert.equal(entered, true);
  assert.equal(fs.readFileSync(legacyLock, "utf8"), token);
});

test("a directory at the lock database path fails clearly", () => {
  const dir = tempDir("directory");
  fs.mkdirSync(path.join(dir, ".migrate.lock.db"));
  let entered = false;

  assert.throws(
    () =>
      withMigrationLock(
        () => {
          entered = true;
        },
        { dir, timeoutMs: 60_000 },
      ),
    /Cannot open the database migration lock at .*\.migrate\.lock\.db/,
  );
  assert.equal(entered, false);
});

test("an existing 0775 data dir becomes 0700 when the db module starts", { timeout: 30_000 }, async () => {
  const dir = tempDir("mode");
  fs.chmodSync(dir, 0o775);

  const child = start(importDbSource, { ORBIT_DATA_DIR: dir });
  const result = await child.done;

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("the lock database is private", () => {
  const dir = tempDir("private");

  withMigrationLock(() => undefined, { dir });

  assert.equal(fs.statSync(path.join(dir, ".migrate.lock.db")).mode & 0o777, 0o600);
});
