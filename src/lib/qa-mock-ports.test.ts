import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const mocks = [
  {
    name: "mock provider",
    script: "scripts/qa/mock-provider.mjs",
    readyLine: /^mock provider on http:\/\/127\.0\.0\.1:(\d+)\/v1 model=\S+$/,
    probePath: "/v1/models",
    portEnv: "MOCK_PORT",
  },
  {
    name: "mock ollama",
    script: "scripts/qa/mock-ollama.mjs",
    readyLine: /^mock-ollama port=(\d+)$/,
    probePath: "/qa/received",
    portEnv: "MOCK_OLLAMA_PORT",
  },
] as const;

type Mock = (typeof mocks)[number];

const children: ChildProcess[] = [];
const holders: net.Server[] = [];

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

after(async () => {
  fs.rmSync(path.join(os.tmpdir(), `orbit-mock-requests-${process.pid}.jsonl`), { force: true });
  for (const holder of holders) await new Promise((resolve) => holder.close(resolve));
  await Promise.all(children.map(stop));
});

// The port comes from the first full line on stdout, never from a partial chunk.
function start(mock: Mock, env: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number; stdout: () => string }> {
  const child = spawn(process.execPath, [path.resolve(mock.script)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`${mock.script} printed no full line. stdout: ${stdout} stderr: ${stderr}`)), 5_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const end = stdout.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timer);
      const line = stdout.slice(0, end);
      const match = mock.readyLine.exec(line);
      if (match) resolve({ child, port: Number(match[1]), stdout: () => stdout });
      else reject(new Error(`${mock.script} printed "${line}" as its first line`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${mock.script} exited ${code ?? "null"}. stderr: ${stderr.split("\n").slice(0, 6).join(" | ")}`));
    });
  });
}

function status(port: number, urlPath: string): Promise<number | string> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: urlPath, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

function postChat(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "mock-genui", stream: true, messages: [{ role: "user", content: "[qa:plain] hi" }] });
    const request = http.request(
      { host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { "content-type": "application/json" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function holdPort(): Promise<number> {
  return new Promise((resolve) => {
    const holder = net.createServer().listen(0, "127.0.0.1", () => {
      holders.push(holder);
      resolve((holder.address() as net.AddressInfo).port);
    });
  });
}

for (const mock of mocks) {
  test(`${mock.name} answers on the port it printed`, async () => {
    const { port } = await start(mock);
    assert.equal(await status(port, mock.probePath), 200);
  });

  test(`two ${mock.name}s started at the same moment each answer on their own port`, async () => {
    const [first, second] = await Promise.all([start(mock), start(mock)]);
    assert.notEqual(first.port, second.port);
    assert.equal(await status(first.port, mock.probePath), 200);
    assert.equal(await status(second.port, mock.probePath), 200);
    await stop(first.child);
    assert.equal(await status(first.port, mock.probePath), "ECONNREFUSED");
    assert.equal(await status(second.port, mock.probePath), 200);
  });

  test(`${mock.name} answers on a free port when the environment names a port another process holds`, async () => {
    const busy = await holdPort();
    const { port } = await start(mock, { [mock.portEnv]: String(busy) });
    assert.notEqual(port, busy);
    assert.equal(await status(port, mock.probePath), 200);
  });
}

// verify.mjs reads the ready line, then closes the pipe and exits. A later stdout write would crash the mock with EPIPE.
test("mock provider writes nothing to stdout after its ready line", async () => {
  const provider = await start(mocks[0], { MOCK_REQUEST_LOG: path.join(os.tmpdir(), `orbit-mock-requests-${process.pid}.jsonl`) });
  assert.equal(await postChat(provider.port), 200);
  assert.deepEqual(provider.stdout().split("\n").filter(Boolean).slice(1), []);
});
