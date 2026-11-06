import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const composeEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "", NODE_ENV: "test", ORBIT_SANDBOX: "on",
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DOCKER_CONFIG: process.env.DOCKER_CONFIG,
};
const composeSchema = z.object({
  services: z.record(z.string(), z.object({
    environment: z.record(z.string(), z.string()).default({}),
    networks: z.record(z.string(), z.unknown()).default({}),
  })),
  networks: z.record(z.string(), z.object({ internal: z.boolean().optional() })).default({}),
});

function composeAvailable(t: TestContext) {
  const result = spawnSync("docker", ["compose", "version"], { env: composeEnv, encoding: "utf8" });
  if (result.error && "code" in result.error && result.error.code === "ENOENT"
    || result.status !== 0 && /(?:compose.*not a docker command|unknown command.*compose)/i.test(result.stderr ?? "")) {
    t.skip("Docker Compose is not installed. Install the Compose plugin to check sandbox access.");
    return false;
  }
  assert.equal(result.status, 0, "Docker Compose version check must work");
  return true;
}

function resolvedCompose(files: string[]) {
  const output = execFileSync("docker", ["compose", "--env-file", "/dev/null", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"], {
    env: composeEnv,
    encoding: "utf8",
  });
  const parsed: unknown = JSON.parse(output);
  return composeSchema.parse(parsed);
}

test("default Compose has no Docker API access even when ORBIT_SANDBOX is set", (t) => {
  if (!composeAvailable(t)) return;
  const config = resolvedCompose(["docker-compose.yml"]);
  assert.equal("docker-socket-proxy" in config.services, false, "default Compose must not start a Docker socket proxy");
  assert.equal(config.services.orbit.environment.DOCKER_HOST, undefined);
  assert.notEqual(config.services.orbit.environment.ORBIT_SANDBOX, "on");
  assert.equal("sandbox-api" in config.services.orbit.networks, false);
  assert.equal("sandbox-api" in config.networks, false);
});

test("the explicit sandbox override enables the tool and its private Docker proxy together", (t) => {
  if (!composeAvailable(t)) return;
  const config = resolvedCompose(["docker-compose.yml", "docker-compose.sandbox.yml"]);
  assert.ok(config.services["docker-socket-proxy"]);
  assert.equal(config.services.orbit.environment.ORBIT_SANDBOX, "on");
  assert.equal(config.services.orbit.environment.DOCKER_HOST, "tcp://docker-socket-proxy:2375");
  assert.deepEqual(Object.keys(config.services.orbit.networks).sort(), ["default", "sandbox-api"]);
  assert.deepEqual(Object.keys(config.services["docker-socket-proxy"].networks), ["sandbox-api"]);
  assert.equal(config.networks["sandbox-api"].internal, true);
  assert.equal(config.services["docker-socket-proxy"].environment.CONTAINERS, "1");
  assert.equal(config.services["docker-socket-proxy"].environment.POST, "1");
});

test("user plugin discovery paths reach both Compose security checks without provider keys", (t) => {
  const located = spawnSync("which", ["docker"], { encoding: "utf8" });
  if (located.status !== 0) {
    t.skip("Docker is not installed.");
    return;
  }
  const dockerPath = located.stdout.trim();
  const available = spawnSync(dockerPath, ["compose", "version"], { encoding: "utf8" });
  if (available.status !== 0 && /(?:compose.*not a docker command|unknown command.*compose)/i.test(available.stderr)) {
    t.skip("Docker Compose is not installed.");
    return;
  }
  assert.equal(available.status, 0);
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-compose-discovery-"));
  t.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));
  const calls = path.join(taskDir, "calls");
  const config = path.join(taskDir, "config");
  const profile = path.join(taskDir, "profile");
  fs.mkdirSync(config);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(taskDir, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
if (process.env.HOME !== ${JSON.stringify(process.env.HOME)} || process.env.USERPROFILE !== ${JSON.stringify(profile)} || process.env.DOCKER_CONFIG !== ${JSON.stringify(config)}) {
  console.error("docker: unknown command: docker compose");
  process.exit(1);
}
if (process.env.ORBIT_API_KEY !== undefined) throw new Error("A provider key reached Docker");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(dockerPath)}, args, { env: process.env, encoding: "utf8" });
if (args.includes("config") && result.status === 0) fs.appendFileSync(${JSON.stringify(calls)}, "config\\n");
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern=^default Compose|^the explicit sandbox", "src/lib/compose-sandbox.test.ts"], {
    env: { PATH: `${taskDir}${path.delimiter}${process.env.PATH ?? ""}`, NODE_ENV: "test", HOME: process.env.HOME, USERPROFILE: profile, DOCKER_CONFIG: config, ORBIT_API_KEY: "must-not-forward" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "the Compose checks must pass with user plugin discovery paths");
  const checked = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0;
  assert.equal(checked, 2, "both security checks must inspect Compose instead of silently skipping");
});
