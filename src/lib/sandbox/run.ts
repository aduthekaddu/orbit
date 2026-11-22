import Docker from "dockerode";
import { Duplex, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { sandboxOwner } from "./owner.mjs";
import { containerSpec, type RunCodeInput, type RunCodeOutput } from "./spec";

const OUTPUT_LIMIT = 65_536;
const RUN_TIMEOUT_MS = 10_000;
const waitResultSchema = z.object({ StatusCode: z.number().int() });
const SIGKILL_EXIT = 137;

async function killedForMemory(container: Docker.Container): Promise<boolean> {
  try {
    return (await container.inspect()).State?.OOMKilled === true;
  } catch {
    return false;
  }
}

function outputCollector() {
  const bytes = Buffer.alloc(OUTPUT_LIMIT);
  let length = 0;
  let truncated = false;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const kept = Math.min(chunk.length, OUTPUT_LIMIT - length);
      chunk.copy(bytes, length, 0, kept);
      length += kept;
      truncated ||= kept < chunk.length;
      done();
    },
  });
  return {
    stream,
    result() {
      const decoded = new StringDecoder("utf8").end(bytes.subarray(0, length));
      const normalized = Buffer.from(decoded);
      truncated ||= normalized.length > OUTPUT_LIMIT;
      return { text: new StringDecoder("utf8").write(normalized.subarray(0, OUTPUT_LIMIT)), truncated };
    },
  };
}

export class RunStopped extends Error {
  readonly output: RunCodeOutput;

  constructor(output: RunCodeOutput) {
    super("Code run was stopped");
    this.name = "AbortError";
    this.output = output;
  }
}

export function sandboxDocker(): Docker {
  const endpoint = process.env.DOCKER_HOST;
  if (!endpoint || endpoint === "unix:///var/run/docker.sock") {
    return new Docker({ socketPath: "/var/run/docker.sock", timeout: 12_000 });
  }
  const url = new URL(endpoint);
  if (!["tcp:", "http:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]", "docker-socket-proxy"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "" && url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DOCKER_HOST must point to the local Docker socket proxy");
  }
  return new Docker({ protocol: "http", host: url.hostname, port: url.port || "2375", timeout: 12_000 });
}

type Outcome =
  | { kind: "exited"; exitCode: number; oomKilled: boolean }
  | { kind: "timed-out" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };

export type CodeRun = {
  // Settles once, with the first of: the program exits, the deadline passes, the signal aborts, Docker fails.
  result: Promise<RunCodeOutput>;
  // Settles once the container is removed or was never made, or once removing it failed. Never rejects.
  cleanup: Promise<"removed" | "failed">;
};

function statusCodeOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
}

// A run moves through: Docker setup (create, attach, start), running, exited, settled.
// `settle` is the only place the outcome is set; the first call wins, and it disarms the deadline and the abort listener.
// The cleanup task is the only owner of the container. It removes it after the outcome settles, even when Docker
// finishes creating it after a stop already returned, and kills it first when the program had not exited.
export function runCode(docker: Docker, input: RunCodeInput, signal?: AbortSignal): CodeRun {
  signal?.throwIfAborted();
  const started = performance.now();
  const stdout = outputCollector();
  const stderr = outputCollector();
  const settled = Promise.withResolvers<Outcome>();
  let outcome: Outcome | undefined;
  let exitCode: number | undefined;
  const settle = (next: Outcome) => {
    if (outcome) return;
    outcome = next;
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    settled.resolve(next);
  };
  const cancel = () => settle({ kind: "cancelled" });
  // After the program exits, the deadline only stops waiting for its last output.
  const deadline = setTimeout(() => settle(exitCode === undefined ? { kind: "timed-out" } : { kind: "exited", exitCode, oomKilled: false }), RUN_TIMEOUT_MS);
  signal?.addEventListener("abort", cancel, { once: true });

  const result = settled.promise.then((done) => {
    if (done.kind === "failed") throw done.error;
    const out = stdout.result();
    const err = stderr.result();
    const output: RunCodeOutput = {
      stdout: out.text,
      stderr: err.text,
      exitCode: done.kind === "exited" ? done.exitCode : null,
      durationMs: Math.round(performance.now() - started),
      timedOut: done.kind === "timed-out",
      truncated: out.truncated || err.truncated,
      ...(done.kind === "exited" && done.oomKilled ? { oomKilled: true } : {}),
    };
    if (done.kind === "cancelled") throw new RunStopped({ ...output, cancelled: true });
    return output;
  });

  let attached: Duplex | undefined;
  const execute = async (container: Docker.Container) => {
    if (outcome) return;
    const connection = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true, abortSignal: signal });
    if (!(connection instanceof Duplex)) throw new Error("Docker did not provide a duplex attach stream");
    attached = connection;
    if (outcome) return;
    const outputFinished = new Promise<{ kind: "ended" } | { kind: "failed"; error: Error }>((resolve) => {
      connection.once("end", () => resolve({ kind: "ended" }));
      connection.once("error", (error: Error) => resolve({ kind: "failed", error }));
      connection.once("close", () => resolve({ kind: "failed", error: new Error("Docker output connection closed before ending") }));
    });
    docker.modem.demuxStream(connection, stdout.stream, stderr.stream);
    await container.start();
    if (outcome) return;
    const program = async () => {
      connection.end(input.code);
      const { StatusCode } = waitResultSchema.parse(await container.wait());
      if (outcome) return;
      exitCode = StatusCode;
      const output = await outputFinished;
      if (outcome) return;
      if (output.kind === "failed") throw output.error;
      settle({ kind: "exited", exitCode, oomKilled: exitCode === SIGKILL_EXIT && await killedForMemory(container) });
    };
    await Promise.race([program(), settled.promise]);
  };

  const cleanup = (async (): Promise<"removed" | "failed"> => {
    let container: Docker.Container;
    try {
      container = await docker.createContainer(containerSpec(input, sandboxOwner()));
    } catch (error) {
      settle({ kind: "failed", error });
      return "removed";
    }
    try {
      await execute(container);
    } catch (error) {
      settle({ kind: "failed", error });
    }
    attached?.destroy();
    stdout.stream.destroy();
    stderr.stream.destroy();
    try {
      try {
        if (exitCode === undefined) await container.kill({ signal: "SIGKILL" });
      } catch (error) {
        if (statusCodeOf(error) !== 409) throw error;
      } finally {
        await container.remove({ force: true });
      }
      return "removed";
    } catch (error) {
      console.error("Sandbox cleanup failed", { statusCode: statusCodeOf(error) });
      return "failed";
    }
  })();

  return { result, cleanup };
}
