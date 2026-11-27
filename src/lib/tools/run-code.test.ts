import { dataDirectory } from "../paths";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { getDb } from "../db";
import { Redactor } from "../chat-errors";
import { parseViewer } from "../policy";
import { toolsFor, type ToolContext } from "./index";
import { createRunCodeTool } from "./run-code";
import { runCodeInputSchema } from "../sandbox/spec";

after(() => {
  getDb().$client.close();
});

test("run_code requires the server gate and the admin switch", () => {
  const original = process.env.ORBIT_SANDBOX;
  const settings = sandboxSettings();
  try {
    for (const value of [undefined, "off", "true", "ON", "on"]) {
      if (value === undefined) delete process.env.ORBIT_SANDBOX;
      else process.env.ORBIT_SANDBOX = value;
      for (const sandbox of ["on", "off"] as const) {
        assert.equal("run_code" in toolsFor(sandboxContext(settings, sandbox)), value === "on" && sandbox === "on");
      }
    }
  } finally {
    if (original === undefined) delete process.env.ORBIT_SANDBOX;
    else process.env.ORBIT_SANDBOX = original;
  }
});

test("the tool registry opens its database in the test data directory", () => {
  assert.equal(getDb().$client.name, path.join(dataDirectory(), "orbit.db"));
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

function dockerFrame(streamType: 1 | 2, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function startFakeDockerHttp(
  t: TestContext,
  handler: (emit: (type: 1 | 2, data: string | Buffer) => void, finish: (code?: number) => void, waiting: Promise<void>) => void,
) {
  let socket: import("node:stream").Duplex | undefined;
  let waitResolve: ((code: number) => void) | undefined;
  let waitCode: number | undefined;
  let started = false;
  const waiting = Promise.withResolvers<void>();
  const removed = Promise.withResolvers<void>();
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && url.includes("/containers/create")) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "fake-c1" }));
      return;
    }
    if (request.method === "GET" && url.includes("/events")) {
      response.writeHead(200, { "content-type": "application/json" });
      return;
    }
    if (request.method === "POST" && url.includes("/start")) {
      started = true;
      const emit = (type: 1 | 2, data: string | Buffer) => {
        socket?.write(dockerFrame(type, data));
      };
      const finish = (code = 0) => {
        socket?.end();
        waitCode = code;
        waitResolve?.(code);
      };
      handler(emit, finish, waiting.promise);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && url.includes("/wait")) {
      waiting.resolve();
      const reply = (code: number) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ StatusCode: code }));
      };
      if (waitCode !== undefined) reply(waitCode);
      else waitResolve = reply;
      return;
    }
    if (request.method === "POST" && url.includes("/kill")) {
      response.writeHead(started ? 204 : 409).end();
      return;
    }
    if (request.method === "DELETE" && url.includes("/containers/")) {
      response.writeHead(204).end();
      removed.resolve();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  server.on("upgrade", (_request, sock) => {
    socket = sock;
    sock.resume();
    sock.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await removed.promise;
    socket?.destroy();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  setDockerHost(t, `http://127.0.0.1:${address.port}`);
}

function sandboxSettings() {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "made-up-provider-key-0001",
    model: "mock",
    reasoningEffort: "low" as const,
    searxngUrl: "",
    tavilyApiKey: "made-up-tavily-key-0002",
    githubToken: "made-up-github-token-0003",
    githubMcpUrl: "",
  };
}

function sandboxContext(settings: ReturnType<typeof sandboxSettings>, sandbox: ToolContext["instance"]["sandbox"] = "on"): ToolContext {
  const viewer = parseViewer({ id: "sandbox-admin", role: "admin" });
  return {
    instance: { ...settings, sandbox },
    user: { id: viewer.id, memory: true, github: settings },
  };
}

function enableSandbox(t: TestContext) {
  const originalSandbox = process.env.ORBIT_SANDBOX;
  process.env.ORBIT_SANDBOX = "on";
  t.after(() => {
    if (originalSandbox === undefined) delete process.env.ORBIT_SANDBOX;
    else process.env.ORBIT_SANDBOX = originalSandbox;
  });
}

test("run_code masks stored credentials in stdout, stderr, and ANSI-split output", async (t) => {
  enableSandbox(t);
  const settings = sandboxSettings();
  await startFakeDockerHttp(t, (emit, finish) => {
    emit(1, `out ${settings.apiKey} and made-up\u001b[31m-github-token-0003\n`);
    emit(2, `err ${settings.tavilyApiKey}\n`);
    finish(0);
  });
  const tool = toolsFor(sandboxContext(settings), undefined, undefined, new Redactor(settings)).run_code;
  assert.ok(tool?.execute);
  const output = (await tool.execute({ language: "python", code: "print(1)" }, { toolCallId: "rc1", messages: [], context: {} })) as {
    stdout: string;
    stderr: string;
  };
  assert.equal(output.stdout, "out [redacted] and [redacted]\n");
  assert.equal(output.stderr, "err [redacted]\n");
});

test("run_code masks a stored credential that straddles the 64 KiB output cap without leaving a prefix", async (t) => {
  enableSandbox(t);
  const settings = sandboxSettings();
  await startFakeDockerHttp(t, (emit, finish) => {
    emit(1, "a".repeat(65_530) + settings.apiKey + "tail");
    finish(0);
  });
  const tool = toolsFor(sandboxContext(settings), undefined, undefined, new Redactor(settings)).run_code;
  assert.ok(tool?.execute);
  const output = (await tool.execute({ language: "python", code: "print(1)" }, { toolCallId: "rc2", messages: [], context: {} })) as {
    stdout: string;
    truncated: boolean;
  };
  assert.equal(output.truncated, true);
  assert.equal(output.stdout.includes("made-u"), false, `clipped prefix leaked: ${output.stdout.slice(-30)}`);
  assert.ok(Buffer.byteLength(output.stdout) <= 65_536);
});

test("run_code masks stored credentials collected before a stopped run is cancelled", async (t) => {
  enableSandbox(t);
  const settings = sandboxSettings();
  const controller = new AbortController();
  const readyToStop = Promise.withResolvers<void>();
  await startFakeDockerHttp(t, (emit, _finish, waiting) => {
    emit(1, `partial ${settings.apiKey}\n`);
    void waiting.then(() => readyToStop.resolve());
  });
  const { createStoppedRuns } = await import("./stopped-runs");
  const stopped = createStoppedRuns();
  const tool = toolsFor(sandboxContext(settings), stopped, undefined, new Redactor(settings)).run_code;
  assert.ok(tool?.execute);
  const pending = Promise.resolve(tool.execute({ language: "python", code: "while True: pass" }, { toolCallId: "rc3", messages: [], abortSignal: controller.signal, context: {} }));
  await readyToStop.promise;
  controller.abort();
  const caught = await pending.then(() => assert.fail("expected RunStopped"), (error: unknown) => error as { output?: { stdout?: string } });
  assert.equal(caught.output?.stdout?.includes(settings.apiKey), false, `stopped stdout leaked key: ${caught.output?.stdout}`);
  assert.equal(caught.output?.stdout, "partial [redacted]\n");
});

test("render_ui masks stored credentials in its returned spec output", async () => {
  const settings = sandboxSettings();
  const tool = toolsFor(sandboxContext(settings), undefined, undefined, new Redactor(settings)).render_ui;
  assert.ok(tool?.execute);
  const result = await tool.execute(
    {
      root: "card",
      elements: {
        card: { type: "Card", props: { title: `Key ${settings.apiKey}`, description: null }, children: [] },
      },
    },
    { toolCallId: "ui1", messages: [], context: {} },
  );
  assert.equal(JSON.stringify(result).includes(settings.apiKey), false, `render_ui leaked key: ${JSON.stringify(result)}`);
});

test("run_code masks misaligned Basic-auth base64 credentials streamed across stdout chunks", async (t) => {
  enableSandbox(t);
  const settings = sandboxSettings();
  const basic = Buffer.from(`user:${settings.apiKey}`).toString("base64");
  const line = `Authorization: Basic ${basic} ok\n`;
  await startFakeDockerHttp(t, (emit, finish) => {
    for (let i = 0; i < line.length; i += 4) emit(1, line.slice(i, i + 4));
    finish(0);
  });
  const tool = toolsFor(sandboxContext(settings), undefined, undefined, new Redactor(settings)).run_code;
  assert.ok(tool?.execute);
  const output = (await tool.execute({ language: "python", code: "print(1)" }, { toolCallId: "rc-b64", messages: [], context: {} })) as {
    stdout: string;
  };
  assert.equal(output.stdout.includes(basic.slice(6)), false, `run_code leaked Basic-auth suffix: ${output.stdout}`);
  assert.match(output.stdout, /Authorization: Basic dXNlcj\[redacted\] ok\n/);
});
