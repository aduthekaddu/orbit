// Plain JavaScript so verify-orbit and the QA scripts, which run without tsx, share it with the server.
import { randomUUID } from "node:crypto";

// Every Orbit sandbox container on a host carries this label. Filtering on it alone sees other Orbit
// processes' containers, so only code that acts on every Orbit container on the host may do that.
const SANDBOX_LABEL = "orbit.sandbox";
// The process that created the container: one Orbit server, one test file, or one QA script.
const OWNER_LABEL = "orbit.owner";
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function parseSandboxOwner(value) {
  if (!OWNER_PATTERN.test(value)) {
    throw new Error("A sandbox owner is 1 to 128 letters, digits, dots, dashes or underscores, and starts with a letter or digit");
  }
  return value;
}

// ORBIT_SANDBOX_OWNER lets a caller that starts processes, such as verify-orbit or CI, choose their owner.
export function ownerFromEnv(env = process.env) {
  const value = env.ORBIT_SANDBOX_OWNER;
  return value === undefined || value === "" ? undefined : parseSandboxOwner(value);
}

let processOwner;

export function sandboxOwner() {
  processOwner ??= ownerFromEnv() ?? parseSandboxOwner(randomUUID());
  return processOwner;
}

export function sandboxLabels(owner) {
  return { [SANDBOX_LABEL]: "true", [OWNER_LABEL]: owner };
}

export function ownedSandboxFilter(owner) {
  return { label: [`${SANDBOX_LABEL}=true`, `${OWNER_LABEL}=${owner}`] };
}

export function ownedSandboxFilterArgs(owner) {
  return ownedSandboxFilter(owner).label.flatMap((label) => ["--filter", `label=${label}`]);
}
