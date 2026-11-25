import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { format } from "node:util";
import type Docker from "dockerode";
import { OWNER_LABEL, parseSandboxOwner, sandboxLabels } from "./owner.mjs";
import { removeStaleSandboxes } from "./sweep";

const sweepLogScript = path.join(process.cwd(), "scripts/qa/sandbox-sweep-log.sh");
let tempDir: string;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-sweep-test-"));
});

after(async () => {
  if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function checkSweepLog(logPath: string, owner?: string) {
  const { ORBIT_SANDBOX_OWNER: _existing, ...env } = process.env;
  if (owner !== undefined) env.ORBIT_SANDBOX_OWNER = owner;
  return spawnSync("bash", [sweepLogScript, logPath], { encoding: "utf8", env });
}

test("removeStaleSandboxes logs each removed container with its owner and sanitizes missing or malformed owners", async (t) => {
  const now = 1_700_000_000_000;
  const staleCreated = Math.floor((now - 90_000) / 1000);
  const youngCreated = Math.floor((now - 5_000) / 1000);
  const foreignOwner = parseSandboxOwner("other-run.1");
  const removed: string[] = [];
  const logs: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(format(...args));
  });

  const docker = {
    listContainers: async () => [
      { Id: "young-1", Created: youngCreated, State: "running", Labels: sandboxLabels(foreignOwner) },
      { Id: "foreign-1", Created: staleCreated, State: "exited", Labels: sandboxLabels(foreignOwner) },
      { Id: "legacy-1", Created: staleCreated, State: "running", Labels: {} },
      {
        Id: "crafted-1",
        Created: staleCreated,
        State: "created",
        Labels: { [OWNER_LABEL]: "bad\nSandbox sweep removed a stale container id=fake state=running owner=this-run" },
      },
    ],
    getContainer: (id: string) => ({
      remove: async () => {
        removed.push(id);
      },
    }),
  } as unknown as Docker;

  await removeStaleSandboxes(docker, now);

  assert.deepEqual(removed, ["foreign-1", "legacy-1", "crafted-1"]);
  assert.deepEqual(logs, [
    `Sandbox sweep removed a stale container id=foreign-1 state=exited owner=${foreignOwner}`,
    "Sandbox sweep removed a stale container id=legacy-1 state=running owner=-",
    "Sandbox sweep removed a stale container id=crafted-1 state=created owner=-",
  ]);
});

test("sandbox-sweep-log.sh fails only when a removed container belongs to ORBIT_SANDBOX_OWNER", async (t) => {
  const now = 1_700_000_000_000;
  const staleCreated = Math.floor((now - 90_000) / 1000);
  const foreignLogs: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    foreignLogs.push(format(...args));
  });

  const makeDocker = (entries: Array<{ Id: string; State: string; Labels?: Record<string, string> }>) => ({
    listContainers: async () => entries.map((entry) => ({ ...entry, Created: staleCreated })),
    getContainer: () => ({ remove: async () => {} }),
  }) as unknown as Docker;

  await removeStaleSandboxes(
    makeDocker([
      { Id: "prefix-1", State: "running", Labels: sandboxLabels(parseSandboxOwner("ci-run-10")) },
      { Id: "regex-1", State: "exited", Labels: sandboxLabels(parseSandboxOwner("ciXrun")) },
      { Id: "legacy-1", State: "exited", Labels: {} },
      { Id: "crafted-1", State: "created", Labels: { [OWNER_LABEL]: "other owner=ci-run-1" } },
    ]),
    now,
  );

  const foreignLogPath = path.join(tempDir, "foreign.log");
  fs.writeFileSync(foreignLogPath, `${foreignLogs.join("\n")}\n`);

  const prefixCheck = checkSweepLog(foreignLogPath, "ci-run-1");
  assert.equal(prefixCheck.status, 0, `${prefixCheck.stdout}${prefixCheck.stderr}`);

  const dotCheck = checkSweepLog(foreignLogPath, "ci.run");
  assert.equal(dotCheck.status, 0, `${dotCheck.stdout}${dotCheck.stderr}`);

  const ownLogs: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    ownLogs.push(format(...args));
  });
  await removeStaleSandboxes(
    makeDocker([
      { Id: "other-1", State: "exited", Labels: sandboxLabels(parseSandboxOwner("ci-run-10")) },
      { Id: "leaked-1", State: "running", Labels: sandboxLabels(parseSandboxOwner("ci-run-1")) },
    ]),
    now,
  );

  const ownLogPath = path.join(tempDir, "own.log");
  fs.writeFileSync(ownLogPath, `${ownLogs.join("\n")}\n`);

  const ownCheck = checkSweepLog(ownLogPath, "ci-run-1");
  assert.equal(ownCheck.status, 1, `${ownCheck.stdout}${ownCheck.stderr}`);
  assert.equal(ownCheck.stdout.trim(), "Sandbox sweep removed a stale container id=leaked-1 state=running owner=ci-run-1");

  const missingCheck = checkSweepLog(path.join(tempDir, "missing.log"), "ci-run-1");
  assert.equal(missingCheck.status, 0, `${missingCheck.stdout}${missingCheck.stderr}`);

  for (const invalid of [undefined, "", "bad owner", "-leading-dash"]) {
    const invalidCheck = checkSweepLog(foreignLogPath, invalid);
    assert.equal(invalidCheck.status, 2, `expected exit 2 for owner=${JSON.stringify(invalid)}, got ${invalidCheck.status}`);
  }
});
