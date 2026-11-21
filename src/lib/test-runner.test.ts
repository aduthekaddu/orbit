import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

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

function runSuite(source: string | Record<string, string>, args: string[] = [], options: RunOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-runner-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.symlinkSync(modules, path.join(dir, "node_modules"), "dir");
  const files = typeof source === "string" ? { "fixture.test.ts": source } : source;
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "src", name), `import { describe, test } from "node:test";\n${content}\n`);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.ORBIT_TEST_SEED;
  delete env.ORBIT_TEST_WORKERS;
  if (options.seed !== undefined) env.ORBIT_TEST_SEED = options.seed;
  const workers = options.workers === undefined ? "1" : options.workers;
  if (workers !== null) env.ORBIT_TEST_WORKERS = workers;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: dir, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  for (const invalid of ["0", "-1", "1.5", "abc", "", "257"]) {
    const envResult = runSuite(fixture, ["--require-all"], { workers: invalid });
    assert.equal(envResult.status, 1, `ORBIT_TEST_WORKERS=${JSON.stringify(invalid)} should fail`);
    assert.match(envResult.stderr, /ORBIT_TEST_WORKERS must be an integer between 1 and 256/);

    const cliResult = runSuite(fixture, ["--require-all", `--workers=${invalid}`], { workers: null });
    assert.equal(cliResult.status, 1, `--workers=${JSON.stringify(invalid)} should fail`);
    assert.match(cliResult.stderr, /--workers must be an integer between 1 and 256/);
  }

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
