import type Docker from "dockerode";
import { z } from "zod";
import { sandboxDocker } from "./run";
import { SANDBOX_LABEL } from "./spec";

// A live run removes its container within the ten-second limit plus its Docker request timeouts, under a
// minute. An older sandbox container was left by a process that died mid-run, here or in another Orbit.
const STALE_AFTER_MS = 60_000;
const listedSchema = z.array(z.object({ Id: z.string(), Created: z.number(), State: z.string() }));

type ErrorFields = { name?: unknown; code?: unknown; statusCode?: unknown };

// Only these fields are logged. An error message can carry the Docker endpoint.
function errorFields(error: unknown): ErrorFields {
  if (error === null || typeof error !== "object") return {};
  const { name, code, statusCode } = error as ErrorFields;
  return { name, code, statusCode };
}

export async function removeStaleSandboxes(docker: Docker, now: number): Promise<void> {
  const containers = listedSchema.parse(await docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=true`] } }));
  for (const { Id, Created, State } of containers) {
    if (now - Created * 1000 < STALE_AFTER_MS) continue;
    try {
      await docker.getContainer(Id).remove({ force: true });
    } catch (error) {
      // Its run or another sweep removed it first.
      const { statusCode } = errorFields(error);
      if (statusCode !== 404 && statusCode !== 409) throw error;
      continue;
    }
    // scripts/qa/ci-e2e.sh fails on this line, so a container a run leaked cannot vanish before its leftover check.
    // One line, so grep shows the id. An object argument wraps once the id makes it long.
    console.warn(`Sandbox sweep removed a stale container id=${Id} state=${State}`);
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
