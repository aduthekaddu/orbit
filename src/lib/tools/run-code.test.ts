import { dataDirectory } from "../paths";
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createRunCodeTool } from "./run-code";
import { runCodeInputSchema } from "../sandbox/spec";

test("run_code exists only when the server explicitly enables it", async () => {
  const { toolsFor } = await import("./index");
  const original = process.env.ORBIT_SANDBOX;
  const settings = { baseUrl: "http://localhost/v1", apiKey: "fake", model: "fake", reasoningEffort: "low" as const, searxngUrl: "", tavilyApiKey: "", githubToken: "", githubMcpUrl: "" };
  try {
    for (const value of [undefined, "off", "true", "ON", "on"]) {
      if (value === undefined) delete process.env.ORBIT_SANDBOX;
      else process.env.ORBIT_SANDBOX = value;
      assert.equal("run_code" in toolsFor(settings), value === "on");
    }
  } finally {
    if (original === undefined) delete process.env.ORBIT_SANDBOX;
    else process.env.ORBIT_SANDBOX = original;
  }
});

test("the tool registry opens its database in the test data directory", async () => {
  const { db } = await import("../db");
  assert.equal(db.$client.name, path.join(dataDirectory(), "orbit.db"));
});

test("model input allows only the two languages and at most 20000 characters", () => {
  assert.ok(runCodeInputSchema.safeParse({ language: "python", code: "x".repeat(20000) }).success);
  assert.ok(runCodeInputSchema.safeParse({ language: "javascript", code: "" }).success);
  assert.ok(!runCodeInputSchema.safeParse({ language: "shell", code: "id" }).success);
  assert.ok(!runCodeInputSchema.safeParse({ language: "python", code: "x".repeat(20001) }).success);
});

function setDockerHost(t: TestContext, host: string) {
  const original = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = host;
  t.after(() => {
    if (original === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = original;
  });
}

function captureErrors(t: TestContext) {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  return logs;
}

async function failingDocker(t: TestContext, status: number) {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "private-sandbox-payload" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  setDockerHost(t, `tcp://127.0.0.1:${address.port}`);
  return requests;
}

async function executeCode(abortSignal?: AbortSignal) {
  const execute = createRunCodeTool().execute;
  assert.ok(execute);
  return execute({ language: "python", code: "print('private-sandbox-source')" }, { toolCallId: "error-check", messages: [], abortSignal, context: {} });
}

test("an invalid Docker host reports configuration and logs no endpoint or source", async (t) => {
  setDockerHost(t, "tcp://private-sandbox-endpoint:2375");
  const logs = captureErrors(t);
  const result = await executeCode();
  assert.deepEqual(result, { ok: false, error: "Sandbox configuration is invalid. Check DOCKER_HOST on the server." });
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs), /ConfigurationError/);
  assert.doesNotMatch(JSON.stringify(logs), /private-sandbox|DOCKER_HOST must/);
});

test("a proxy denial reports access denied and logs only its safe category and status", async (t) => {
  const requests = await failingDocker(t, 403);
  const logs = captureErrors(t);
  const result = await executeCode();
  assert.deepEqual(result, { ok: false, error: "Sandbox access was denied. Check the Docker proxy." });
  assert.equal(requests.length, 1);
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs), /"status":403/);
  assert.doesNotMatch(JSON.stringify({ logs, result }), /private-sandbox/);
});

test("an unexpected Docker failure returns a neutral message and safe status", async (t) => {
  await failingDocker(t, 500);
  const logs = captureErrors(t);
  const result = await executeCode();
  assert.deepEqual(result, { ok: false, error: "Code sandbox failed. Check the server logs." });
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs), /"status":500/);
  assert.doesNotMatch(JSON.stringify({ logs, result }), /private-sandbox/);
});

test("a missing image keeps its pull instruction without exposing the Docker response", async (t) => {
  await failingDocker(t, 404);
  captureErrors(t);
  const result = await executeCode();
  assert.ok("error" in result);
  assert.match(result.error, /^Sandbox image is missing\. Run docker pull /);
  assert.doesNotMatch(JSON.stringify(result), /private-sandbox/);
});

test("an aborted code run is rethrown without a failure log", async (t) => {
  setDockerHost(t, "unix:///var/run/docker.sock");
  const logs = captureErrors(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeCode(controller.signal), { name: "AbortError" });
  assert.deepEqual(logs, []);
});
