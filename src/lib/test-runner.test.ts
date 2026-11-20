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

function runSuite(source: string, ...args: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-runner-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.symlinkSync(modules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(path.join(dir, "src/fixture.test.ts"), `import { describe, test } from "node:test";\n${source}\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: dir, env, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

test("a complete run passes the full-suite gate", () => {
  const result = runSuite(`test("runs", () => {});`, "--require-all");
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, source] of [
  ["a skipped test", `test("runs", () => {});\ntest.skip("skipped", () => {});`],
  ["a skipped suite", `test("runs", () => {});\ndescribe.skip("skipped suite", () => { test("hidden", () => {}); });`],
  ["a todo test", `test("runs", () => {});\ntest.todo("later");`],
  ["a todo suite", `test("runs", () => {});\ndescribe.todo("later suite", () => { test("hidden", () => {}); });`],
]) {
  test(`${name} fails the full-suite gate and passes an ordinary run`, () => {
    const gated = runSuite(source, "--require-all");
    assert.equal(gated.status, 1, `the gate let ${name} through`);
    assert.match(gated.stderr, /Full suite needs every test to pass/);
    assert.equal(runSuite(source).status, 0);
  });
}
