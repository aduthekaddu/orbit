import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { z } from "zod";

const composeEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test", ORBIT_SANDBOX: "on" };
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
