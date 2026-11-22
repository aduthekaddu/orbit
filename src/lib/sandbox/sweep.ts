import type Docker from "dockerode";
import { z } from "zod";
import { sandboxDocker } from "./run";
import { SANDBOX_LABEL } from "./spec";

// A live run removes its container within the ten-second limit plus its Docker request timeouts, under a
// minute. An older sandbox container was left by a process that died mid-run, here or in another Orbit.
const STALE_AFTER_MS = 60_000;
const listedSchema = z.array(z.object({ Id: z.string(), Created: z.number() }));

function statusCode(error: unknown) {
  return error !== null && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
}

export async function removeStaleSandboxes(docker: Docker, now: number): Promise<void> {
  const containers = listedSchema.parse(await docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=true`] } }));
  for (const { Id, Created } of containers) {
    if (now - Created * 1000 < STALE_AFTER_MS) continue;
    try {
      await docker.getContainer(Id).remove({ force: true });
    } catch (error) {
      // Its run or another sweep removed it first.
      if (statusCode(error) !== 404 && statusCode(error) !== 409) throw error;
    }
  }
}

// Sweeps at start and every minute, so a container skipped as too young is removed on a later pass.
export function startSandboxSweep(): void {
  const sweep = async () => {
    try {
      await removeStaleSandboxes(sandboxDocker(), Date.now());
    } catch (error) {
      console.error("Sandbox sweep failed", { statusCode: statusCode(error) });
    }
  };
  void sweep();
  setInterval(sweep, STALE_AFTER_MS).unref();
}
