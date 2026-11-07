import type { UIMessage } from "ai";
import { hasStoppedCodeOutput } from "./sandbox/spec";

type RunPart = { type: "tool-run_code"; toolCallId?: string; state?: string; output?: unknown };

const asRunPart = (part: unknown) =>
  part && typeof part === "object" && (part as { type?: unknown }).type === "tool-run_code" ? (part as RunPart) : null;

// The call id of a code run that has no result yet.
const openCallId = (part: unknown) => {
  const run = asRunPart(part);
  return run?.toolCallId && run.state !== "output-available" && run.state !== "output-error" ? run.toolCallId : undefined;
};

// A code run with no result when the stream ends is one the user stopped.
export function hasOpenCodeRun(message: UIMessage): boolean {
  return message.parts.some((part) => openCallId(part) !== undefined);
}

// The AI SDK drops the tool result of a stopped request, so the live card has none.
// Sending a new message before the saved result arrives makes assistant-ui close the run with its own error instead.
// The server saves the result after the stop. Copy it onto the matching live parts and leave everything else as it is.
export function restoreStoppedRuns(live: UIMessage[], saved: UIMessage): UIMessage[] {
  const results = new Map<string, unknown>();
  for (const part of saved.parts) {
    const run = asRunPart(part);
    if (run?.toolCallId && run.state === "output-available" && hasStoppedCodeOutput(run.output)) results.set(run.toolCallId, run.output);
  }
  if (results.size === 0) return live;
  let changed = false;
  const next = live.map((message) => {
    if (message.id !== saved.id) return message;
    let restored = false;
    const parts = message.parts.map((part) => {
      const run = asRunPart(part);
      if (!run?.toolCallId || run.state === "output-available" || !results.has(run.toolCallId)) return part;
      restored = true;
      const result: Record<string, unknown> = { ...run, state: "output-available", output: results.get(run.toolCallId) };
      delete result.errorText;
      return result as typeof part;
    });
    if (!restored) return message;
    changed = true;
    return { ...message, parts };
  });
  return changed ? next : live;
}
