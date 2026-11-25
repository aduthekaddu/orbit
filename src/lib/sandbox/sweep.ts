import type Docker from "dockerode";
import { z } from "zod";
import { ownerFromLabels } from "./owner.mjs";
import { sandboxDocker } from "./run";

// A live run removes its container within the ten-second limit plus its Docker request timeouts, under a
// minute. An older sandbox container was left by a process that died mid-run, here or in another Orbit.
const STALE_AFTER_MS = 60_000;
const listedSchema = z.array(z.object({
  Id: z.string(),
  Created: z.number(),
  State: z.string(),
  Labels: z.record(z.string(), z.string()).optional(),
}));

type ErrorFields = { name?: unknown; code?: unknown; statusCode?: unknown };

// Only these fields are logged. An error message can carry the Docker endpoint.
function errorFields(error: unknown): ErrorFields {
  if (error === null || typeof error !== "object") return {};
  const { name, code, statusCode } = error as ErrorFields;
  return { name, code, statusCode };
}

export async function removeStaleSandboxes(docker: Docker, now: number): Promise<void> {
  const containers = listedSchema.parse(await docker.listContainers({ all: true, filters: { label: ["orbit.sandbox=true"] } }));
  for (const { Id, Created, State, Labels } of containers) {
    if (now - Created * 1000 < STALE_AFTER_MS) continue;
    try {
      await docker.getContainer(Id).remove({ force: true });
    } catch (error) {
      // Its run or another sweep removed it first.
      const { statusCode } = errorFields(error);
      if (statusCode !== 404 && statusCode !== 409) throw error;
      continue;
    }
    const owner = ownerFromLabels(Labels) ?? "-";
    // scripts/qa/ci-e2e.sh fails when this line carries its ORBIT_SANDBOX_OWNER, so a container a run leaked
    // cannot vanish before its leftover check while another process's stale container does not fail the suite.
    // One line, so log checks see id, state, and owner together. An object argument wraps once the id makes it long.
    console.warn(`Sandbox sweep removed a stale container id=${Id} state=${State} owner=${owner}`);
  }
}

// Sweeps at start and every minute, so a container skipped as too young is removed on a later pass.
export function startSandboxSweep(): void {
  const sweep = async () => {
    try {
      await removeStaleSandboxes(sandboxDocker(), Date.now());
    } catch (error) {
      console.error("Sandbox sweep failed", errorFields(error));
    }
  };
  void sweep();
  setInterval(sweep, STALE_AFTER_MS).unref();
}
