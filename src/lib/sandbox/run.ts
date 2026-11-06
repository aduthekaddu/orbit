import Docker from "dockerode";
import { Duplex, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { containerSpec, type RunCodeInput, type RunCodeOutput } from "./spec";

const OUTPUT_LIMIT = 65_536;
const RUN_TIMEOUT_MS = 10_000;
const waitResultSchema = z.object({ StatusCode: z.number().int() });

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
      const decoded = new StringDecoder("utf8").write(bytes.subarray(0, length));
      const normalized = Buffer.from(decoded);
      truncated ||= normalized.length > OUTPUT_LIMIT;
      return { text: new StringDecoder("utf8").write(normalized.subarray(0, OUTPUT_LIMIT)), truncated };
    },
  };
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

export async function runCode(docker: Docker, input: RunCodeInput, signal?: AbortSignal): Promise<RunCodeOutput> {
  signal?.throwIfAborted();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let stopReason: "timed-out" | "cancelled" | undefined;
  const stopped = new Promise<"timed-out" | "cancelled">((resolve) => {
    const stop = (reason: "timed-out" | "cancelled") => {
      stopReason ??= reason;
      resolve(stopReason);
    };
    timer = setTimeout(() => stop("timed-out"), RUN_TIMEOUT_MS);
    onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) stop("cancelled");
  });
  const stdout = outputCollector();
  const stderr = outputCollector();
  const completed = async (): Promise<number | "timed-out" | "cancelled"> => {
    const container = await docker.createContainer(containerSpec(input));
    let attached: Duplex | undefined;
    try {
      if (stopReason) return stopReason;
      const connection = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true, abortSignal: signal });
      if (!(connection instanceof Duplex)) throw new Error("Docker did not provide a duplex attach stream");
      attached = connection;
      if (stopReason) return stopReason;
      const outputFinished = new Promise<{ kind: "ended" } | { kind: "failed"; error: Error }>((resolve) => {
        connection.once("end", () => resolve({ kind: "ended" }));
        connection.once("error", (error: Error) => resolve({ kind: "failed", error }));
        connection.once("close", () => resolve({ kind: "failed", error: new Error("Docker output connection closed before ending") }));
      });
      docker.modem.demuxStream(connection, stdout.stream, stderr.stream);
      await container.start();
      if (stopReason) return stopReason;
      const exited = async () => {
        connection.end(input.code);
        const result = waitResultSchema.parse(await container.wait());
        const output = await outputFinished;
        if (output.kind === "failed") throw output.error;
        clearTimeout(timer);
        return result.StatusCode;
      };
      return await Promise.race([exited(), stopped]);
    } finally {
      attached?.destroy();
      stdout.stream.destroy();
      stderr.stream.destroy();
      try {
        try {
          if (stopReason) {
            try {
              await container.kill({ signal: "SIGKILL" });
            } catch (error) {
              if (!(error && typeof error === "object" && "statusCode" in error && error.statusCode === 409)) throw error;
            }
          }
        } finally {
          await container.remove({ force: true });
        }
      } catch (error) {
        const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
        console.error("Sandbox cleanup failed", { statusCode });
        throw error;
      }
    }
  };
  try {
    const outcome = await Promise.race([completed(), stopped]);
    if (outcome === "cancelled") throw new DOMException("Code run was stopped", "AbortError");
    const out = stdout.result();
    const err = stderr.result();
    return {
      stdout: out.text,
      stderr: err.text,
      exitCode: outcome === "timed-out" ? null : outcome,
      durationMs: Math.round(performance.now() - started),
      timedOut: outcome === "timed-out",
      truncated: out.truncated || err.truncated,
    };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
