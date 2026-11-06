import { RunStopped } from "../sandbox/run";
import type { RunCodeOutput } from "../sandbox/spec";

export type StoppedRuns = ReturnType<typeof createStoppedRuns>;

// The AI SDK drops a tool result that arrives after the request is aborted, so
// a stopped run reports its output here and the chat route puts it back.
export function createStoppedRuns() {
  const outputs = new Map<string, RunCodeOutput>();
  const running = new Set<Promise<void>>();
  return {
    track<T>(toolCallId: string, run: Promise<T>): Promise<T> {
      const watched = run.then(
        () => undefined,
        (error: unknown) => {
          if (error instanceof RunStopped) outputs.set(toolCallId, error.output);
        },
      );
      running.add(watched);
      void watched.then(() => running.delete(watched));
      return run;
    },
    async apply(parts: unknown): Promise<unknown> {
      await Promise.all(running);
      if (!Array.isArray(parts) || outputs.size === 0) return parts;
      return parts.map((part) => {
        if (!part || typeof part !== "object") return part;
        const record = part as Record<string, unknown>;
        const output = typeof record.toolCallId === "string" ? outputs.get(record.toolCallId) : undefined;
        if (!output || record.type !== "tool-run_code" || record.state === "output-available" || record.state === "output-error") return part;
        return { ...record, state: "output-available", output };
      });
    },
  };
}
