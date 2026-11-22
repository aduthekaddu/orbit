import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ownerFromEnv } from "./owner.mjs";

const repo = process.cwd();
const scanned = ["src", "scripts", ".agents", ".github"];
const bareLabel = ["orbit", "sandbox"].join(".");
// Files that may name the bare label: the helper that owns it, and the test that pins the container policy.
// Add a file here only when its job is to act on every Orbit container on the host.
const allowed = new Set(["src/lib/sandbox/owner.mjs", "src/lib/sandbox/spec.test.ts"]);

test("ORBIT_SANDBOX_OWNER names the owner, and a value that could change a Docker filter is refused", () => {
  assert.equal(ownerFromEnv({ ORBIT_SANDBOX_OWNER: "verify-3f2a.1_b" }), "verify-3f2a.1_b");
  assert.equal(ownerFromEnv({}), undefined);
  assert.equal(ownerFromEnv({ ORBIT_SANDBOX_OWNER: "" }), undefined);
  for (const value of ["a b", "--filter", "a=b", "x".repeat(129)]) {
    assert.throws(() => ownerFromEnv({ ORBIT_SANDBOX_OWNER: value }), /sandbox owner/);
  }
});

test(`no file lists Docker containers by the bare ${bareLabel} label`, () => {
  for (const file of allowed) assert.ok(existsSync(path.join(repo, file)), `${file} is in the allowlist but does not exist`);
  const offenders = scanned.flatMap((dir) =>
    readdirSync(path.join(repo, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name)))
      .filter((file) => !allowed.has(file) && readFileSync(path.join(repo, file), "latin1").includes(bareLabel)));
  assert.deepEqual(offenders, [], [
    `These files name the ${bareLabel} label, which every Orbit process's containers carry, so a check on it fails on another run's container:`,
    ...offenders.map((file) => `  ${file}`),
    "List or wait for containers with ownedSandboxFilter(owner) or ownedSandboxFilterArgs(owner) from src/lib/sandbox/owner.mjs.",
    "A file whose job is to act on every Orbit container on the host goes in the allowlist in src/lib/sandbox/owner.test.ts.",
  ].join("\n"));
});
