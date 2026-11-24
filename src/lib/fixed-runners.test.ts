import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const RUNNER = "ubuntu-24.04";
const FIX = `Write "runs-on: ${RUNNER}". See docs/adr/0003-ci-on-github-hosted-runners.md.`;

function runnerProblems(file: string, source: string) {
  const workflow = parse(source) as { jobs?: Record<string, { "runs-on"?: unknown; uses?: unknown }> } | null;
  const problems: string[] = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (typeof job.uses === "string") {
      if (!job.uses.startsWith("./")) problems.push(`${file}: job "${name}" calls ${job.uses}, which picks its own runner. Call a workflow in this repository or inline the job.`);
    } else if (job["runs-on"] !== RUNNER) {
      problems.push(`${file}: job "${name}" has runs-on ${JSON.stringify(job["runs-on"])}. ${FIX}`);
    }
  }
  return problems;
}

const job = (runsOn: string) => `jobs:\n  checks:\n    ${runsOn}\n    steps: []\n`;

test("a job on the fixed GitHub-hosted runner passes, quoted or with a comment", () => {
  assert.deepEqual(runnerProblems("ci.yml", job(`runs-on: ${RUNNER}`)), []);
  assert.deepEqual(runnerProblems("ci.yml", job(`"runs-on": "${RUNNER}" # hosted`)), []);
});

test("the runner variable that left runs queued on 2026-11-20 and 2026-11-22 fails, and the error names the fix", () => {
  const [problem, ...rest] = runnerProblems("ci.yml", job("runs-on: ${{ vars.CI_RUNNER || 'ubuntu-24.04' }}"));
  assert.deepEqual(rest, []);
  assert.match(problem, /^ci\.yml: job "checks" has runs-on "\$\{\{ vars\.CI_RUNNER/);
  assert.ok(problem.endsWith(FIX));
});

for (const runsOn of [
  "runs-on: romper-linux",
  "runs-on: self-hosted # runs-on: ubuntu-24.04",
  "runs-on: [self-hosted, linux]",
  `runs-on:\n      - ${RUNNER}\n      - self-hosted`,
  "runs-on: ubuntu-22.04",
  "runs-on : ${{ matrix.os }}",
  "timeout-minutes: 5",
]) {
  test(`a job with ${JSON.stringify(runsOn)} fails`, () => {
    assert.equal(runnerProblems("ci.yml", job(runsOn)).length, 1);
  });
}

test("an inline job mapping is read like any other job", () => {
  assert.equal(runnerProblems("ci.yml", "jobs:\n  checks: { runs-on: self-hosted, steps: [] }\n").length, 1);
});

test("a job may call a workflow in this repository but not one outside it", () => {
  assert.deepEqual(runnerProblems("ci.yml", "jobs:\n  call:\n    uses: ./.github/workflows/build.yml\n"), []);
  assert.equal(runnerProblems("ci.yml", "jobs:\n  call:\n    uses: octo-org/shared/.github/workflows/build.yml@v1\n").length, 1);
});

test("every workflow in this repository runs on the fixed GitHub-hosted runner", () => {
  const dir = path.join(process.cwd(), ".github/workflows");
  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0);
  assert.deepEqual(files.flatMap((name) => runnerProblems(name, fs.readFileSync(path.join(dir, name), "utf8"))), []);
});
