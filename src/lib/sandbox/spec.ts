import type Docker from "dockerode";
import { z } from "zod";
import { sandboxImages } from "./images";

export const RUN_TIMEOUT_SECONDS = 10;
export const SANDBOX_LABEL = "orbit.sandbox";

export const runCodeInputSchema = z.object({
  language: z.enum(["python", "javascript"]),
  code: z.string().max(20_000),
});

export const runCodeOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  cancelled: z.boolean().optional(),
  oomKilled: z.boolean().optional(),
});

export type RunCodeInput = z.infer<typeof runCodeInputSchema>;
export type RunCodeOutput = z.infer<typeof runCodeOutputSchema>;

export type CodeRunOutcome =
  | { kind: "stopped" }
  | { kind: "timed-out" }
  | { kind: "out-of-memory"; exitCode: number | null }
  | { kind: "killed" }
  | { kind: "exited"; exitCode: number };

export function codeRunOutcome(output: RunCodeOutput): CodeRunOutcome {
  if (output.cancelled) return { kind: "stopped" };
  if (output.timedOut) return { kind: "timed-out" };
  if (output.oomKilled) return { kind: "out-of-memory", exitCode: output.exitCode };
  if (output.exitCode === null) return { kind: "killed" };
  return { kind: "exited", exitCode: output.exitCode };
}

export function codeRunFailed(outcome: CodeRunOutcome): boolean {
  return outcome.kind !== "stopped" && !(outcome.kind === "exited" && outcome.exitCode === 0);
}

export function containerSpec(input: RunCodeInput): Docker.ContainerCreateOptions {
  const runtime = sandboxImages[input.language];
  return {
    Image: runtime.image,
    // The container keeps the time limit itself, so it holds when the Orbit process dies mid-run.
    Cmd: ["timeout", "-s", "KILL", String(RUN_TIMEOUT_SECONDS), ...runtime.command],
    User: "65534:65534",
    NetworkDisabled: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Labels: { [SANDBOX_LABEL]: "true" },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      Memory: 268435456,
      MemorySwap: 268435456,
      NanoCpus: 1000000000,
      PidsLimit: 64,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      AutoRemove: false,
      LogConfig: { Type: "none", Config: {} },
    },
  };
}
