import Docker from "dockerode";
import { Duplex, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { sandboxOwner } from "./owner.mjs";
import { containerSpec, RUN_TIMEOUT_SECONDS, type RunCodeInput, type RunCodeOutput } from "./spec";
import { STOP_MARKERS } from "../tools/run-status";

const OUTPUT_LIMIT = 65_536;
const RUN_TIMEOUT_MS = RUN_TIMEOUT_SECONDS * 1000;
const MEMORY_CHECK_TIMEOUT_MS = 5_000;
const waitResultSchema = z.object({ StatusCode: z.number().int(), Error: z.object({ Message: z.string() }).nullish() });
const SIGKILL_EXIT = 137;

// False when Docker does not confirm a memory kill within five seconds, so a stalled inspect reply cannot hold the run.
async function killedForMemory(container: Docker.Container): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), MEMORY_CHECK_TIMEOUT_MS); });
  try {
    return await Promise.race([container.inspect().then((info) => info.State?.OOMKilled === true), gaveUp]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
    super(STOP_MARKERS.codeRunStopped);
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

type Exit = { exitCode: number; oomKilled: boolean };

type Outcome =
  | { kind: "exited"; exit: Exit; outputEnded: boolean }
  | { kind: "timed-out" }
  | { kind: "cancelled"; exit: Exit | undefined }
  | { kind: "failed"; error: unknown };

export type CodeRun = {
  // Settles once, with the first of: the program exits, the deadline passes, the signal aborts, Docker fails.
  // After the program exits, an abort keeps what Docker reported about the exit, and the deadline only stops waiting
  // for the last output, which then counts as truncated.
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
  const started = performance.now();
  const stdout = outputCollector();
  const stderr = outputCollector();
  const settled = Promise.withResolvers<Outcome>();
  let outcome: Outcome | undefined;
  let exit: Exit | undefined;
  const outputCutOff = Promise.withResolvers<{ kind: "cut-off" }>();
  const settle = (next: Outcome) => {
    if (outcome) return;
    outcome = next;
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    settled.resolve(next);
  };
  const cancel = () => settle({ kind: "cancelled", exit });
  const deadline = setTimeout(() => exit === undefined ? settle({ kind: "timed-out" }) : outputCutOff.resolve({ kind: "cut-off" }), RUN_TIMEOUT_MS);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();

  const result = settled.promise.then((done) => {
    if (done.kind === "failed") throw done.error;
    const out = stdout.result();
    const err = stderr.result();
    const exited = done.kind === "timed-out" ? undefined : done.exit;
    const output: RunCodeOutput = {
      stdout: out.text,
      stderr: err.text,
      exitCode: exited?.exitCode ?? null,
      durationMs: Math.round(performance.now() - started),
      timedOut: done.kind === "timed-out",
      truncated: out.truncated || err.truncated || done.kind === "exited" && !done.outputEnded,
      ...(exited?.oomKilled ? { oomKilled: true } : {}),
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
      const reply = waitResultSchema.parse(await container.wait());
      if (outcome) return;
      if (reply.Error) throw new Error(`Docker could not wait for the program: ${reply.Error.Message}`);
      const elapsedAtWait = performance.now() - started;
      exit = { exitCode: reply.StatusCode, oomKilled: false };
      const output = Promise.race([outputFinished, outputCutOff.promise]);
      if (reply.StatusCode === SIGKILL_EXIT && await killedForMemory(container)) exit = { exitCode: reply.StatusCode, oomKilled: true };
      const ended = await output;
      if (outcome) return;
      if (ended.kind === "failed") throw ended.error;
      // The container's own limit fired before Orbit's timer ran.
      if (reply.StatusCode === SIGKILL_EXIT && !exit.oomKilled && elapsedAtWait >= RUN_TIMEOUT_MS) {
        settle({ kind: "timed-out" });
        return;
      }
      settle({ kind: "exited", exit, outputEnded: ended.kind === "ended" });
    };
    await Promise.race([program(), settled.promise]);
  };

  const cleanup = (async (): Promise<"removed" | "failed"> => {
    if (outcome) return "removed";
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
    const logFailure = (error: unknown) => console.error("Sandbox cleanup failed", { containerId: container.id, statusCode: statusCodeOf(error) });
    // Kill before removing, so a denied removal cannot leave the program running. 409: it never started or already exited.
    if (exit === undefined) {
      await container.kill({ signal: "SIGKILL" }).catch((error: unknown) => {
        if (statusCodeOf(error) !== 409) logFailure(error);
      });
    }
    return container.remove({ force: true }).then(() => "removed" as const, (error: unknown) => {
      logFailure(error);
      return "failed" as const;
    });
  })();

  return { result, cleanup };
}

// For a script that exits when it has the result: settles only after cleanup, even when the run failed.
export async function runCodeToEnd(docker: Docker, input: RunCodeInput) {
  const run = runCode(docker, input);
  const output = await run.result.finally(() => run.cleanup);
  return { output, cleanup: await run.cleanup };
}
