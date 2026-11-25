#!/usr/bin/env node
// Exits 1 when a sandbox container made by the processes that share ORBIT_SANDBOX_OWNER remains.
import { execFileSync } from "node:child_process";
import { ownedSandboxFilterArgs, ownerFromEnv } from "../../src/lib/sandbox/owner.mjs";

const owner = ownerFromEnv();
if (!owner) {
  console.error("Set ORBIT_SANDBOX_OWNER to the owner whose containers to check.");
  process.exit(2);
}
const remaining = execFileSync("docker", ["ps", "-a", ...ownedSandboxFilterArgs(owner), "--format", "{{.ID}} {{.Status}}"], { encoding: "utf8" }).trim();
if (remaining) {
  console.error(`sandbox containers owned by ${owner} remain:\n${remaining}`);
  process.exit(1);
}
console.log(`no sandbox containers owned by ${owner} remain`);
