import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

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
  fs.writeFileSync("ready.log", db.$client.name + "\\n" + process.pid);
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
      for (let waited = 0; !fs.existsSync(ready) || !fs.readFileSync(ready, "utf8").includes("\n"); waited += 50) {
        assert.ok(waited < 20_000, "the fixture never opened its database");
        await sleep(50);
      }
      filePid = Number(fs.readFileSync(ready, "utf8").split("\n")[1]);
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
