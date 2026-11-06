import type Docker from "dockerode";
import { z } from "zod";
import { sandboxImages } from "./images";

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

export function hasStoppedCodeOutput(output: unknown): boolean {
  const parsed = runCodeOutputSchema.safeParse(output);
  return parsed.success && parsed.data.cancelled === true;
}

export function hasFailedCodeOutput(output: unknown): boolean {
  const parsed = runCodeOutputSchema.safeParse(output);
  return parsed.success && !parsed.data.cancelled && (parsed.data.timedOut || parsed.data.exitCode !== 0);
}

export function containerSpec(input: RunCodeInput): Docker.ContainerCreateOptions {
  const runtime = sandboxImages[input.language];
  return {
    Image: runtime.image,
    Cmd: [...runtime.command],
    User: "65534:65534",
    NetworkDisabled: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Labels: { "orbit.sandbox": "true" },
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
