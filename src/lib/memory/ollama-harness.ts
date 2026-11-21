import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export async function startMockOllama(): Promise<{ url: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, [path.join(process.cwd(), "scripts/qa/mock-ollama.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("mock ollama did not listen")), 5_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /mock-ollama port=(\d+)/.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock ollama exited ${code ?? "null"}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null || child.signalCode) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
}
