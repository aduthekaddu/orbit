import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";

const mocks = [
  { name: "mock provider", script: "scripts/qa/mock-provider.mjs", portLine: /mock provider on http:\/\/127\.0\.0\.1:(\d+)\/v1/, portEnv: "MOCK_PORT" },
  { name: "mock ollama", script: "scripts/qa/mock-ollama.mjs", portLine: /mock-ollama port=(\d+)/, portEnv: "MOCK_OLLAMA_PORT" },
] as const;

const children: ChildProcess[] = [];
const holders: net.Server[] = [];

after(async () => {
  for (const holder of holders) await new Promise((resolve) => holder.close(resolve));
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        }),
    ),
  );
});

function start(script: string, portLine: RegExp, env: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, [path.resolve(script)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${script} printed no port. Output: ${output}`)), 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = portLine.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${script} exited ${code ?? "null"}. Output: ${output.split("\n").slice(0, 6).join(" | ")}`));
    });
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
  test(`two ${mock.name}s started at the same moment listen on different ports`, async () => {
    const [first, second] = await Promise.all([start(mock.script, mock.portLine), start(mock.script, mock.portLine)]);
    assert.notEqual(first, second);
  });

  test(`${mock.name} does not take a port that another process holds, whatever the environment asks for`, async () => {
    const busy = await holdPort();
    const port = await start(mock.script, mock.portLine, { [mock.portEnv]: String(busy) });
    assert.notEqual(port, busy);
  });
}
