import { execFileSync } from "node:child_process";
import { eventually } from "../../../src/lib/eventually.mjs";

const SPINNING_PERCENT = 10;

// A sandbox container reads its program from stdin, so a running container may not have started the program yet.
// The mock provider's run-spin and run-timeout programs spin, and a spinning program uses a full CPU.
function readSandboxCpu() {
  const ids = execFileSync("docker", ["ps", "-q", "--filter", "label=orbit.sandbox=true", "--filter", "status=running"], { encoding: "utf8" })
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length === 0) return { containers: 0, cpuPercent: [] };
  try {
    const cpuPercent = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}", ...ids], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseFloat(value));
    return { containers: ids.length, cpuPercent };
  } catch {
    // A container can exit between the listing and the sample.
    return { containers: ids.length, cpuPercent: [] };
  }
}

export function waitForSpinningProgram() {
  return eventually(readSandboxCpu, ({ cpuPercent }) => cpuPercent.some((percent) => percent >= SPINNING_PERCENT), {
    timeoutMs: 30_000,
    intervalMs: 50,
    what: "a sandbox container whose program uses CPU",
  });
}
