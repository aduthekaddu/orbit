import type Docker from "dockerode";

export async function waitForRunningSandbox(docker: Docker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await docker.listContainers({ filters: { label: ["orbit.sandbox=true"], status: ["running"] } });
    if (running.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no sandbox container started");
}
