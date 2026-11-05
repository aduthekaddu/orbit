import assert from "node:assert/strict";
import { cpus, loadavg } from "node:os";
import Docker from "dockerode";
import { runCode } from "../../src/lib/sandbox/run";

async function main() {
  const docker = new Docker();
  console.log(`cores=${cpus().length} load1=${loadavg()[0].toFixed(2)} runs=10 code=print(1) images=already-pulled`);
  console.log("Measured wall time includes container creation, attach, execution, output collection, and removal.");
  const times: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    const result = await runCode(docker, { language: "python", code: "print(1)" });
    const elapsed = performance.now() - started;
    assert.equal(result.stdout, "1\n");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    times.push(elapsed);
    console.log(`run=${index + 1} wallMs=${elapsed.toFixed(1)} durationMs=${result.durationMs.toFixed(1)} stdout=1 exit=0`);
  }
  const sorted = [...times].sort((left, right) => left - right);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  console.log(`successes=10 errors=0 minMs=${sorted[0].toFixed(1)} maxMs=${sorted.at(-1)?.toFixed(1)} p50Ms=${p50.toFixed(1)} p95Ms=${p95.toFixed(1)} method=nearest-rank`);
  assert.deepEqual(await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["orbit.sandbox"] }) }), []);
  console.log("sandbox containers remaining=0");
  assert.ok(p95 < 1500, `p95 ${p95.toFixed(1)} ms exceeds the 1500 ms budget`);
  console.log("PASS sandbox p95 is below 1500 ms");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Sandbox timing failed");
  process.exitCode = 1;
});
