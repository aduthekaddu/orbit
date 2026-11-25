import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { codeRunFailed, codeRunOutcome, runCodeOutputSchema } from "../sandbox/spec";
import type { ToolName } from "./metadata";

/** Every text a stored tool part carries to say the call ended early. Saved chats hold these values. */
export const STOP_MARKERS = {
  /** The errorText settleInterruptedParts writes on a call its stream left open. */
  stopped: "Stopped",
  /** The message of RunStopped. Older versions saved it as a code run's errorText. */
  codeRunStopped: "Code run was stopped",
  /** The output.error of a web search that Stop ended. */
  searchStopped: "Search was stopped",
  /** The errorText @assistant-ui/ai-sdk writes when a follow-up message closes an open call. */
  cancelledOnSend: "User cancelled tool call by sending a new message.",
} as const;

type StopMarker = keyof typeof STOP_MARKERS;

const markers = new Map(Object.entries(STOP_MARKERS).map(([name, text]) => [text as string, name as StopMarker]));

function stopMarker(text: unknown): StopMarker | undefined {
  return typeof text === "string" ? markers.get(text) : undefined;
}

export type ToolRunEnd =
  | { status: "running" }
  | { status: "succeeded" }
  /** `error` is the text of a call that threw. A call that returned a failing result has none. */
  | { status: "failed"; error?: string }
  /** `saved` is the result a stopped call kept, such as a code run's partial output. */
  | { status: "cancelled"; saved?: unknown };

export type ToolRunStatus = ToolRunEnd["status"];

export type ToolRunPart =
  | { state: "input-streaming" | "input-available" }
  | { state: "output-available"; output: unknown }
  | { state: "output-error"; errorText?: string };

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function codeRunEnd(output: unknown): ToolRunEnd | undefined {
  const parsed = runCodeOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const outcome = codeRunOutcome(parsed.data);
  if (outcome.kind === "stopped") return { status: "cancelled", saved: output };
  return codeRunFailed(outcome) ? { status: "failed" } : undefined;
}

function errorOutputEnd(output: unknown): ToolRunEnd | undefined {
  return typeof field(output, "error") === "string" ? { status: "failed" } : undefined;
}

type OutputEnd = (output: unknown) => ToolRunEnd | undefined;

const outputEnds = new Map<string, OutputEnd>(Object.entries({
  run_code: codeRunEnd,
  remember: errorOutputEnd,
  forget: errorOutputEnd,
} satisfies Partial<Record<ToolName, OutputEnd>>));

function outputEnd(output: unknown, stopped: boolean, toolName: string | undefined): ToolRunEnd {
  if (toolName === "render_ui" && output == null) return stopped ? { status: "cancelled" } : { status: "running" };
  if (field(output, "ok") === false) {
    return stopMarker(field(output, "error")) === "searchStopped" ? { status: "cancelled", saved: output } : { status: "failed" };
  }
  const end = outputEnds.get(toolName ?? "")?.(output);
  if (end) return end;
  return field(output, "isError") === true ? { status: "failed" } : { status: "succeeded" };
}

/** How a tool call ended, from its UI part. `stopped` says the run that made the part is over. */
export function toolRunEnd(part: ToolRunPart, stopped = false, toolName?: string): ToolRunEnd {
  switch (part.state) {
    case "output-available":
      return outputEnd(part.output, stopped, toolName);
    case "output-error": {
      const marker = stopMarker(part.errorText);
      // assistant-ui closes every open call with the same text; treat it as cancelled for every tool. https://github.com/aduthekaddu/orbit/issues/194
      const cancelled = marker !== undefined;
      return cancelled ? { status: "cancelled" } : { status: "failed", error: part.errorText ?? "" };
    }
    case "input-streaming":
    case "input-available":
      return stopped ? { status: "cancelled" } : { status: "running" };
  }
}

type ToolCallProps = Pick<ToolCallMessagePartProps, "status" | "result" | "isError"> & Partial<Pick<ToolCallMessagePartProps, "toolName">>;

/** How a tool call ended, from the props assistant-ui passes a tool card. */
export function toolCallRunEnd(props: ToolCallProps): ToolRunEnd {
  let part: ToolRunPart;
  if (props.isError) {
    const error = field(props.result, "error");
    part = { state: "output-error", errorText: typeof error === "string" ? error : undefined };
  } else if (props.result !== undefined) {
    part = { state: "output-available", output: props.result };
  } else {
    part = { state: "input-available" };
  }
  return toolRunEnd(part, props.status.type !== "running", props.toolName);
}
