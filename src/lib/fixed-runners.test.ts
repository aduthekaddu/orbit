import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const script = path.join(process.cwd(), "scripts/ci/fixed-runners.sh");
const dirs: string[] = [];

function check(runsOn: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-runners-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "ci.yml"), `jobs:\n  checks:\n    ${runsOn}\n    steps: []\n`);
  return spawnSync("bash", [script, dir], { encoding: "utf8" });
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a fixed GitHub-hosted label passes", () => {
  assert.equal(check("runs-on: ubuntu-24.04").status, 0);
});

test("the runner variable that left runs queued on 2026-11-20 and 2026-11-22 fails, and the error names the fix", () => {
  const result = check("runs-on: ${{ vars.CI_RUNNER || 'ubuntu-24.04' }}");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ci\.yml:3:/);
  assert.match(result.stdout, /runs-on: ubuntu-24\.04/);
});

test("a self-hosted label fails", () => {
  assert.equal(check("runs-on: romper-linux").status, 1);
  assert.equal(check("runs-on: [self-hosted, linux]").status, 1);
});

test("the repository's own workflows pass", () => {
  const result = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
});
