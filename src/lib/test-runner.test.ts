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

function runSuite(source: string | Record<string, string>, args: string[] = [], seed?: string) {
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
  if (seed !== undefined) env.ORBIT_TEST_SEED = seed;
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

test("the seed reproduces file order without losing TS or TSX tests", () => {
  const fixtures = {
    "alpha.test.ts": `test("fixture alpha", () => {});`,
    "beta.test.tsx": `test("fixture beta", () => {});`,
    "gamma.test.ts": `test("fixture gamma", () => {});`,
    "delta.test.tsx": `test("fixture delta", () => {});`,
  };
  const orders = ["419", "419", "192"].map((seed) => {
    const result = runSuite(fixtures, ["--require-all", "--shuffle"], seed);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`Orbit test order seed: ${seed} \\(4 files\\)`));
    return [...result.stdout.matchAll(/^ok \d+ - fixture (\w+)$/gm)].map((match) => match[1]);
  });
  assert.deepEqual([...orders[0]].sort(), ["alpha", "beta", "delta", "gamma"]);
  assert.deepEqual(orders[0], orders[1]);
  assert.notDeepEqual(orders[0], orders[2]);
});

test("shuffling still fails the full-suite gate for a skipped suite", () => {
  const result = runSuite({
    "alpha.test.ts": `test("runs", () => {});`,
    "beta.test.tsx": `describe.skip("skipped suite", () => { test("hidden", () => {}); });`,
  }, ["--require-all", "--shuffle"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Full suite needs every test to pass/);
});
