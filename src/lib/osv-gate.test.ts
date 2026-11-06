import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const script = path.join(process.cwd(), "scripts/ci/osv-gate.sh");
const hasJq = spawnSync("jq", ["--version"]).status === 0;
let directory: string;

type Entry = [name: string, version: string, groups: string[], ...ids: string[]];

// The shape that OSV-Scanner prints with --format json, cut down to what the gate reads.
function scan(...entries: Entry[]) {
  const packages = entries.map(([name, version, groups, ...ids]) => ({
    package: { name, version, ecosystem: "npm" },
    dependency_groups: groups,
    vulnerabilities: ids.map((id) => ({ id })),
  }));
  return JSON.stringify({ results: [{ packages }] });
}

function gate(head: string, base?: string) {
  fs.writeFileSync(path.join(directory, "head.json"), head);
  if (base !== undefined) fs.writeFileSync(path.join(directory, "base.json"), base);
  const result = spawnSync("bash", base === undefined ? [script] : [script, "base-package-lock.json"], {
    encoding: "utf8",
    env: { ...process.env, OSV_FIXTURE_DIR: directory },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

const skip = !hasJq && "jq is needed";

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-osv-gate-"));
});

after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("a pull request that leaves the vulnerabilities as they are passes", { skip }, () => {
  const known = scan(["lodash", "4.17.15", [], "GHSA-1"], ["postcss", "8.5.10", ["dev"], "GHSA-2"]);
  assert.equal(gate(known, known).ok, true);
});

test("a pull request that adds a vulnerable package fails", { skip }, () => {
  const result = gate(scan(["lodash", "4.17.15", [], "GHSA-1"], ["minimist", "1.0.0", [], "GHSA-9"]), scan(["lodash", "4.17.15", [], "GHSA-1"]));
  assert.equal(result.ok, false);
  assert.match(result.output, /GHSA-9 {2}minimist@1\.0\.0/);
});

test("a vulnerable dev dependency that becomes a production one fails", { skip }, () => {
  const result = gate(scan(["lodash", "4.17.15", [], "GHSA-1"]), scan(["lodash", "4.17.15", ["dev"], "GHSA-1"]));
  assert.equal(result.ok, false, result.output);
});

test("a vulnerable production dependency that becomes a dev one passes", { skip }, () => {
  assert.equal(gate(scan(["lodash", "4.17.15", ["dev"], "GHSA-1"]), scan(["lodash", "4.17.15", [], "GHSA-1"])).ok, true);
});

test("a bump from one vulnerable version to another that is still vulnerable passes", { skip }, () => {
  assert.equal(gate(scan(["postcss", "8.5.12", ["dev"], "GHSA-2"]), scan(["postcss", "8.5.10", ["dev"], "GHSA-2"])).ok, true);
});

test("a second vulnerable version of a package that is already vulnerable fails", { skip }, () => {
  const result = gate(scan(["lodash", "4.17.15", [], "GHSA-1"], ["lodash", "4.17.20", [], "GHSA-1"]), scan(["lodash", "4.17.15", [], "GHSA-1"]));
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /GHSA-1 {2}lodash@4\.17\.20/);
});

test("on main, a vulnerable production dependency fails", { skip }, () => {
  const result = gate(scan(["lodash", "4.17.15", [], "GHSA-1"]));
  assert.equal(result.ok, false);
  assert.match(result.output, /Production vulnerabilities/);
});

test("on main, vulnerable dev dependencies only warn", { skip }, () => {
  const result = gate(scan(["postcss", "8.5.10", ["dev"], "GHSA-2"]));
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /warning title=Dev dependency vulnerabilities/);
});
