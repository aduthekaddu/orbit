import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { eventually } from "./eventually.mjs";

const runner = path.join(process.cwd(), "scripts/test.mjs");
const modules = path.join(process.cwd(), "node_modules");
const dirs: string[] = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

type RunOptions = {
  seed?: string;
  workers?: string | null;
};

function makeProject(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-runner-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.symlinkSync(modules, path.join(dir, "node_modules"), "dir");
  fs.symlinkSync(path.join(process.cwd(), "drizzle"), path.join(dir, "drizzle"), "dir");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "src", name), `import { describe, test } from "node:test";\n${content}\n`);
  }
  const tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  delete env.ORBIT_DATA_DIR;
  delete env.ORBIT_TEST_ROOT;
  delete env.ORBIT_TEST_SEED;
  delete env.ORBIT_TEST_WORKERS;
  return { dir, env, tmp };
}

function runSuite(source: string | Record<string, string>, args: string[] = [], options: RunOptions = {}) {
  const { dir, env, tmp } = makeProject(typeof source === "string" ? { "fixture.test.ts": source } : source);
  if (options.seed !== undefined) env.ORBIT_TEST_SEED = options.seed;
  const workers = options.workers === undefined ? "1" : options.workers;
  if (workers !== null) env.ORBIT_TEST_WORKERS = workers;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: dir, env, encoding: "utf8" });
  return { dir, tmp, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a complete run passes the full-suite gate", () => {
  const result = runSuite(`test("runs", () => {});`, ["--require-all"]);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, source] of [
  ["a skipped test", `test("runs", () => {});\ntest.skip("skipped", () => {});`],
  ["a skipped suite", `test("runs", () => {});\ndescribe.skip("skipped suite", () => { test("hidden", () => {}); });`],
  ["a todo test", `test("runs", () => {});\ntest.todo("later");`],
  ["a todo suite", `test("runs", () => {});\ndescribe.todo("later suite", () => { test("hidden", () => {}); });`],
]) {
  test(`${name} fails the full-suite gate and passes an ordinary run`, () => {
    const gated = runSuite(source, ["--require-all"]);
    assert.equal(gated.status, 1, `the gate let ${name} through`);
    assert.match(gated.stderr, /Full suite needs every test to pass/);
    assert.equal(runSuite(source).status, 0);
  });
}

test("the seed reproduces file dispatch order without losing TS or TSX tests", () => {
  const fixtures = {
    "alpha.test.ts": `test("fixture alpha", () => {});`,
    "beta.test.tsx": `test("fixture beta", () => {});`,
    "gamma.test.ts": `test("fixture gamma", () => {});`,
    "delta.test.tsx": `test("fixture delta", () => {});`,
  };
  const runOrder = (args: string[], seed: string) => {
    const result = runSuite(fixtures, args, { seed });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`Orbit test order seed: ${seed} \\(4 files, 1 worker\\)`));
    return [...result.stdout.matchAll(/^ok \d+ - fixture (\w+)$/gm)].map((match) => match[1]);
  };
  const shuffled = runOrder(["--require-all", "--shuffle"], "419");
  const replayed = runOrder(["--require-all"], "419");
  const different = runOrder(["--require-all", "--shuffle"], "192");
  assert.deepEqual([...shuffled].sort(), ["alpha", "beta", "delta", "gamma"]);
  assert.deepEqual(shuffled, replayed);
  assert.notDeepEqual(shuffled, different);
});

test("shuffling still fails the full-suite gate for a skipped suite", () => {
  const result = runSuite({
    "alpha.test.ts": `test("runs", () => {});`,
    "beta.test.tsx": `describe.skip("skipped suite", () => { test("hidden", () => {}); });`,
  }, ["--require-all", "--shuffle"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Full suite needs every test to pass/);
});

test("unknown flags and positional arguments fail explicitly instead of silently dropping options", () => {
  const skipped = `test("runs", () => {});\ntest.skip("skipped", () => {});`;
  const typo = runSuite(skipped, ["--requir-all"]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Unknown option '--requir-all'/);

  const positional = runSuite(`test("runs", () => {});`, ["fixture.test.ts"]);
  assert.equal(positional.status, 1);
  assert.match(positional.stderr, /Unexpected argument 'fixture\.test\.ts'/);

  const terminator = runSuite(`test("runs", () => {});`, ["--"]);
  assert.equal(terminator.status, 1);
  assert.match(terminator.stderr, /Unexpected argument '--'/);
});

test("worker count overrides are validated and logged alongside the seed", () => {
  const fixture = `test("runs", () => {});`;
  for (const invalid of ["0", "-1", "1.5", "abc", "", "9007199254740992"]) {
    const envResult = runSuite(fixture, ["--require-all"], { workers: invalid });
    assert.equal(envResult.status, 1, `ORBIT_TEST_WORKERS=${JSON.stringify(invalid)} should fail`);
    assert.match(envResult.stderr, /ORBIT_TEST_WORKERS must be a positive safe integer/);

    const cliResult = runSuite(fixture, ["--require-all", `--workers=${invalid}`], { workers: null });
    assert.equal(cliResult.status, 1, `--workers=${JSON.stringify(invalid)} should fail`);
    assert.match(cliResult.stderr, /--workers must be a positive safe integer/);
  }

  const largeHostReplay = runSuite(fixture, ["--require-all"], { workers: "257", seed: "419" });
  assert.equal(largeHostReplay.status, 0, largeHostReplay.stderr);
  assert.match(largeHostReplay.stderr, /seed: 419 \(1 file, 257 workers\)/);

  const missingValue = runSuite(fixture, ["--workers"], { workers: null });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--workers/);

  const cliOverride = runSuite(fixture, ["--require-all", "--shuffle", "--workers", "2"], { seed: "419", workers: null });
  assert.equal(cliOverride.status, 0, cliOverride.stderr);
  assert.match(cliOverride.stderr, /Orbit test order seed: 419 \(1 file, 2 workers\)/);

  const expectedDefault = Math.max(os.availableParallelism() - 1, 1);
  const expectedLabel = expectedDefault === 1 ? "worker" : "workers";
  const defaultRun = runSuite(fixture, ["--require-all", "--shuffle"], { seed: "419", workers: null });
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.match(defaultRun.stderr, new RegExp(`Orbit test order seed: 419 \\(1 file, ${expectedDefault} ${expectedLabel}\\)`));
});

// The shape of PR #82: a static import of the database module with no data directory set first.
const dbModule = path.join(process.cwd(), "src/lib/db/index.ts");
const opensDatabase = `import fs from "node:fs";
import { db } from ${JSON.stringify(dbModule)};
test("opens the database", () => {
  fs.appendFileSync("opened.log", db.$client.name + "\\n");
});`;

test("every test file gets its own temporary data directory, removed after the run", () => {
  const result = runSuite({ "alpha.test.ts": opensDatabase, "beta.test.ts": opensDatabase }, ["--require-all"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(result.dir, "data")), false, "a test file opened ./data in the checkout");
  const opened = fs.readFileSync(path.join(result.dir, "opened.log"), "utf8").trim().split("\n");
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0], opened[1], "two test files shared one data directory");
  for (const dbPath of opened) {
    assert.ok(dbPath.startsWith(result.tmp + path.sep), `${dbPath} is outside the temp directory`);
    assert.equal(fs.existsSync(path.dirname(dbPath)), false, `${dbPath} was left behind`);
  }
});

// Each form runs a test file with no NODE_TEST_CONTEXT, so the guard has to recognise the file itself.
const launchForms: Record<string, { file: string; args: string[] }> = {
  "node --test": { file: "fixture.test.ts", args: ["--import", "tsx", "--test"] },
  "node --test with isolation off": { file: "fixture.test.ts", args: ["--import", "tsx", "--test", "--experimental-test-isolation=none"] },
  "node --test on a file not named *.test.ts": { file: "fixture.check.ts", args: ["--import", "tsx", "--test", "--experimental-test-isolation=none"] },
  "node as a plain program": { file: "fixture.test.ts", args: ["--import", "tsx"] },
  "the tsx command": { file: "fixture.test.ts", args: [path.join(modules, "tsx/dist/cli.mjs")] },
};

for (const [name, { file, args }] of Object.entries(launchForms)) {
  test(`a test file run by ${name} without the runner fails with the fix instead of opening ./data`, () => {
    const { dir, env } = makeProject({ [file]: opensDatabase });
    const result = spawnSync(process.execPath, [...args, `src/${file}`], { cwd: dir, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--import \.\/scripts\/test-data-dir\.mjs/);
    assert.equal(fs.existsSync(path.join(dir, "data")), false);
  });
}

test("a program that is not a test file still opens ./data without a data directory", () => {
  const { dir, env } = makeProject({ "tool.ts": `import { db } from ${JSON.stringify(dbModule)};\nconsole.log(db.$client.name);` });
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/tool.ts"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(dir, "data", "orbit.db")));
});

const killsItself = `import fs from "node:fs";
import { db } from ${JSON.stringify(dbModule)};
test("kills itself after opening the database", () => {
  fs.appendFileSync("opened.log", db.$client.name + "\\n");
  process.kill(process.pid, "SIGKILL");
});`;

test("a killed test file leaves nothing in the temp directory after the run", () => {
  const result = runSuite({ "killed.test.ts": killsItself });
  assert.equal(result.status, 1, "the killed file should fail the run");
  assert.ok(fs.existsSync(path.join(result.dir, "opened.log")), "the fixture never opened its database");
  assert.deepEqual(fs.readdirSync(result.tmp).filter((name) => name.startsWith("orbit-test-")), []);
});

const hangs = `import fs from "node:fs";
import { db } from ${JSON.stringify(dbModule)};
test("hangs after opening the database", async () => {
  fs.writeFileSync("ready.tmp", db.$client.name + "\\n" + process.pid);
  fs.renameSync("ready.tmp", "ready.log");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});`;

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`a runner stopped by ${signal} stops its test files, then removes their data directories`, async () => {
    const { dir, env, tmp } = makeProject({ "hangs.test.ts": hangs });
    env.ORBIT_TEST_WORKERS = "1";
    const child = spawn(process.execPath, [runner], { cwd: dir, env, stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
    const ready = path.join(dir, "ready.log");
    let filePid: number | undefined;
    try {
      await eventually(() => fs.existsSync(ready), Boolean, { timeoutMs: 20_000, intervalMs: 50, what: "the fixture to open its database" });
      filePid = Number(fs.readFileSync(ready, "utf8").split("\n")[1]);
      assert.ok(Number.isSafeInteger(filePid) && filePid > 0, `unexpected fixture pid: ${filePid}`);
      assert.ok(fs.readdirSync(tmp).some((name) => name.startsWith("orbit-test-")));
      child.kill(signal);
      assert.equal(await exited, code);
      assert.equal(isAlive(filePid), false, "the test file outlived the runner");
      assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("orbit-test-")), []);
    } finally {
      child.kill("SIGKILL");
      if (filePid && isAlive(filePid)) process.kill(filePid, "SIGKILL");
    }
  });
}

test("a stopped runner waits for a test file's exit handlers and OS exit before exiting", async () => {
  const slowExit = `import fs from "node:fs";
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => {
  const end = Date.now() + 300;
  while (Date.now() < end) {}
  fs.writeFileSync("exit-done.tmp", "done");
  fs.renameSync("exit-done.tmp", "exit-done.log");
});
test("blocks in exit handler on SIGTERM", async () => {
  fs.writeFileSync("ready.tmp", String(process.pid));
  fs.renameSync("ready.tmp", "ready.log");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});`;
  const { dir, env, tmp } = makeProject({ "slow-exit.test.ts": slowExit });
  env.ORBIT_TEST_WORKERS = "1";
  const child = spawn(process.execPath, [runner], { cwd: dir, env, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
  const ready = path.join(dir, "ready.log");
  let filePid: number | undefined;
  try {
    await eventually(() => fs.existsSync(ready), Boolean, { timeoutMs: 20_000, intervalMs: 50, what: "the fixture to start" });
    filePid = Number(fs.readFileSync(ready, "utf8"));
    assert.ok(Number.isSafeInteger(filePid) && filePid > 0, `unexpected fixture pid: ${filePid}`);
    child.kill("SIGTERM");
    assert.equal(await exited, 143);
    assert.equal(isAlive(filePid), false, "the test file outlived the runner");
    assert.equal(fs.existsSync(path.join(dir, "exit-done.log")), true, "the runner exited before the test file finished its exit handler");
    assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("orbit-test-")), []);
  } finally {
    child.kill("SIGKILL");
    if (filePid && isAlive(filePid)) process.kill(filePid, "SIGKILL");
  }
});

test("a stopped runner aborts queued test files instead of spawning them", async () => {
  const roleScript = `import fs from "node:fs";
const tryClaim = (name: string) => {
  try {
    fs.mkdirSync(name);
    return true;
  } catch {
    return false;
  }
};
if (tryClaim("slot-1")) {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      const dirs = fs.readdirSync(process.env.ORBIT_TEST_ROOT!).filter((name) => name.startsWith("orbit-test-data-"));
      fs.writeFileSync("dirs-seen.tmp", String(dirs.length));
      fs.renameSync("dirs-seen.tmp", "dirs-seen.log");
      process.exit(0);
    }, 600);
  });
  test("slow worker", async () => {
    fs.writeFileSync("ready-1.tmp", String(process.pid));
    fs.renameSync("ready-1.tmp", "ready-1.log");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  });
} else if (tryClaim("slot-2")) {
  test("fast worker", async () => {
    fs.writeFileSync("ready-2.tmp", String(process.pid));
    fs.renameSync("ready-2.tmp", "ready-2.log");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  });
} else {
  fs.appendFileSync("queued-ran.log", process.pid + "\\n");
  test("queued worker", async () => {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  });
}`;
  const { dir, env, tmp } = makeProject({
    "a.test.ts": roleScript,
    "b.test.ts": roleScript,
    "c.test.ts": roleScript,
    "d.test.ts": roleScript,
    "e.test.ts": roleScript,
  });
  env.ORBIT_TEST_WORKERS = "2";
  const child = spawn(process.execPath, [runner], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
  const ready1 = path.join(dir, "ready-1.log");
  const ready2 = path.join(dir, "ready-2.log");
  let pid1: number | undefined;
  let pid2: number | undefined;
  try {
    await eventually(() => fs.existsSync(ready1) && fs.existsSync(ready2), Boolean, { timeoutMs: 20_000, intervalMs: 50, what: "the initial workers to start" });
    pid1 = Number(fs.readFileSync(ready1, "utf8"));
    pid2 = Number(fs.readFileSync(ready2, "utf8"));
    assert.ok(Number.isSafeInteger(pid1) && pid1 > 0, `unexpected slow worker pid: ${pid1}`);
    assert.ok(Number.isSafeInteger(pid2) && pid2 > 0, `unexpected fast worker pid: ${pid2}`);
    child.kill("SIGTERM");
    assert.equal(await exited, 143);
    assert.equal(isAlive(pid1), false, "slow worker outlived the runner");
    assert.equal(isAlive(pid2), false, "fast worker outlived the runner");
    assert.equal(fs.existsSync(path.join(dir, "queued-ran.log")), false, "a queued test file ran after SIGTERM");
    const dirsSeen = Number(fs.readFileSync(path.join(dir, "dirs-seen.log"), "utf8"));
    assert.ok(dirsSeen <= 2, `expected at most 2 data dirs for 2 active workers, saw ${dirsSeen}`);
    assert.equal((stdout.match(/signal: 'SIGTERM'/g) ?? []).length, 0, "queued files were spawned and killed by SIGTERM");
    assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("orbit-test-")), []);
  } finally {
    child.kill("SIGKILL");
    if (pid1 && isAlive(pid1)) process.kill(pid1, "SIGKILL");
    if (pid2 && isAlive(pid2)) process.kill(pid2, "SIGKILL");
  }
});

test("a second signal stops a SIGTERM-ignoring test file immediately without leaking its data directory", async () => {
  const stubborn = `import fs from "node:fs";
import { db } from ${JSON.stringify(dbModule)};
process.on("SIGTERM", () => {});
test("ignores SIGTERM after opening the database", async () => {
  fs.writeFileSync("ready.tmp", db.$client.name + "\\n" + process.pid);
  fs.renameSync("ready.tmp", "ready.log");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});`;
  const { dir, env, tmp } = makeProject({ "stubborn.test.ts": stubborn });
  env.ORBIT_TEST_WORKERS = "1";
  const child = spawn(process.execPath, [runner], { cwd: dir, env, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
  const ready = path.join(dir, "ready.log");
  let filePid: number | undefined;
  try {
    await eventually(() => fs.existsSync(ready), Boolean, { timeoutMs: 20_000, intervalMs: 50, what: "the fixture to open its database" });
    filePid = Number(fs.readFileSync(ready, "utf8").split("\n")[1]);
    assert.ok(Number.isSafeInteger(filePid) && filePid > 0, `unexpected fixture pid: ${filePid}`);
    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(isAlive(filePid), true, "expected the stubborn fixture to still be running after first SIGINT");
    const forcedAt = Date.now();
    child.kill("SIGINT");
    assert.equal(await exited, 130);
    const elapsed = Date.now() - forcedAt;
    assert.ok(elapsed < 2_000, `second SIGINT waited ${elapsed}ms instead of stopping immediately`);
    assert.equal(isAlive(filePid), false, "the test file outlived the runner after a second SIGINT");
    assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("orbit-test-")), []);
  } finally {
    child.kill("SIGKILL");
    if (filePid && isAlive(filePid)) process.kill(filePid, "SIGKILL");
  }
});

test("an empty pid file in the test root does not make the runner signal its own process group", async () => {
  const emptyPid = `import fs from "node:fs";
import path from "node:path";
import { db } from ${JSON.stringify(dbModule)};
test("creates an empty sibling pid file then hangs", async () => {
  const sibling = fs.mkdtempSync(path.join(process.env.ORBIT_TEST_ROOT!, "orbit-test-data-empty-"));
  fs.writeFileSync(path.join(sibling, "pid"), "");
  fs.writeFileSync("ready.tmp", db.$client.name + "\\n" + process.pid);
  fs.renameSync("ready.tmp", "ready.log");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});`;
  const { dir, env, tmp } = makeProject({ "empty-pid.test.ts": emptyPid });
  env.ORBIT_TEST_WORKERS = "1";
  const child = spawn(process.execPath, [runner], { cwd: dir, env, detached: true, stdio: "ignore" });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = path.join(dir, "ready.log");
  let filePid: number | undefined;
  try {
    await eventually(() => fs.existsSync(ready), Boolean, { timeoutMs: 20_000, intervalMs: 50, what: "the fixture to open its database" });
    filePid = Number(fs.readFileSync(ready, "utf8").split("\n")[1]);
    assert.ok(Number.isSafeInteger(filePid) && filePid > 0, `unexpected fixture pid: ${filePid}`);
    child.kill("SIGTERM");
    const result = await exited;
    assert.deepEqual(result, { code: 143, signal: null });
    assert.equal(isAlive(filePid), false, "the test file outlived the runner");
    assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("orbit-test-")), []);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already exited.
    }
    if (filePid && isAlive(filePid)) process.kill(filePid, "SIGKILL");
  }
});
