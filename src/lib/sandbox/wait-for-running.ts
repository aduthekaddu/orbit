import type Docker from "dockerode";
import { ownedSandboxFilter, type SandboxOwner } from "./owner.mjs";

export async function waitForRunningSandbox(docker: Docker, owner: SandboxOwner, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await docker.listContainers({ filters: { ...ownedSandboxFilter(owner), status: ["running"] } });
    if (running.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no sandbox container started");
}
