import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
};

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

const workflowPath = path.join(process.cwd(), ".github/workflows/pr-agent.yml");
let tempDir: string;
let stubBinDir: string;
let callLogPath: string;

function loadSteps(): WorkflowStep[] {
  const workflow = parse(fs.readFileSync(workflowPath, "utf8")) as Workflow | null;
  const steps = workflow?.jobs?.["pr-agent"]?.steps;
  assert.ok(Array.isArray(steps), "pr-agent job must define steps");
  return steps;
}

function findPermissionStep(steps: WorkflowStep[]): WorkflowStep {
  const step = steps.find((candidate) => candidate.id === "commenter-permission");
  assert.ok(step, "pr-agent workflow must include a commenter-permission step");
  assert.equal(typeof step.run, "string", "commenter-permission step must have a run script");
  return step;
}

function runPermissionStep(
  script: string,
  options: { commenter: string; repo?: string; permission?: string; ghExit?: number },
) {
  const outputFile = path.join(tempDir, `github-output-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(outputFile, "");
  fs.writeFileSync(callLogPath, "");

  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: outputFile,
      GH_TOKEN: "test-token",
      REPO: options.repo ?? "aduthekaddu/orbit",
      COMMENTER: options.commenter,
      STUB_PERMISSION: options.permission ?? "",
      STUB_EXIT: String(options.ghExit ?? 0),
      STUB_LOG: callLogPath,
    },
  });

  const output = fs.readFileSync(outputFile, "utf8").trim();
  const calls = fs.readFileSync(callLogPath, "utf8").trim();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output, calls };
}

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-pr-agent-workflow-"));
  stubBinDir = path.join(tempDir, "bin");
  callLogPath = path.join(tempDir, "gh-calls.log");
  fs.mkdirSync(stubBinDir);

  const stubGh = path.join(stubBinDir, "gh");
  fs.writeFileSync(
    stubGh,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$STUB_LOG"',
      'if [ "${STUB_EXIT:-0}" -ne 0 ]; then exit "$STUB_EXIT"; fi',
      'printf "%s\\n" "$STUB_PERMISSION"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
});

after(async () => {
  if (tempDir) {
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("issue_comment runs an explicit permission check before the PR-Agent action", () => {
  const steps = loadSteps();
  const checkIndex = steps.findIndex((step) => step.id === "commenter-permission");
  const actionIndex = steps.findIndex((step) => step.uses?.startsWith("the-pr-agent/pr-agent@"));

  assert.ok(checkIndex >= 0, "missing commenter-permission step");
  assert.ok(actionIndex > checkIndex, "commenter-permission step must run before Run PR-Agent");

  const checkStep = steps[checkIndex];
  const actionStep = steps[actionIndex];
  assert.equal(checkStep.if, "github.event_name == 'issue_comment'");
  assert.equal(checkStep.env?.COMMENTER, "${{ github.event.comment.user.login }}");
  assert.equal(checkStep.env?.REPO, "${{ github.repository }}");
  assert.match(
    actionStep.if ?? "",
    /github\.event_name == 'pull_request' \|\| \(github\.event_name == 'issue_comment' && steps\.commenter-permission\.outputs\.allowed == 'true'\)/,
  );
});

for (const permission of ["admin", "write"]) {
  test(`commenter with ${permission} repository permission is allowed`, () => {
    const step = findPermissionStep(loadSteps());
    const result = runPermissionStep(step.run!, { commenter: "maintainer-1", permission });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "allowed=true");
    assert.equal(result.calls, "api repos/aduthekaddu/orbit/collaborators/maintainer-1/permission --jq .permission");
  });
}

for (const permission of ["read", "none"]) {
  test(`commenter with ${permission} repository permission is denied`, () => {
    const step = findPermissionStep(loadSteps());
    const result = runPermissionStep(step.run!, { commenter: "readonly-member", permission });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "allowed=false");
  });
}

test("API error fails closed without allowing the slash command", () => {
  const step = findPermissionStep(loadSteps());
  const result = runPermissionStep(step.run!, { commenter: "someone", ghExit: 1 });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "");
});

for (const invalidLogin of ["", "../other", "dependabot[bot]", "alice?foo=bar"]) {
  test(`invalid commenter login ${JSON.stringify(invalidLogin)} is denied without calling gh`, () => {
    const step = findPermissionStep(loadSteps());
    const result = runPermissionStep(step.run!, { commenter: invalidLogin, permission: "admin" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "allowed=false");
    assert.equal(result.calls, "");
  });
}
