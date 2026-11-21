import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { hasFailedOutput, hasStoppedOutput } from "./metadata";

/** The errorText of a tool call whose stream stopped first. Saved chats store it, so the value must not change. */
export const STOPPED_ERROR = "Stopped";

/** The errorText @assistant-ui/ai-sdk writes when a follow-up message cancels an unresolved tool call. */
const CANCELLED_ON_SEND_ERROR = "User cancelled tool call by sending a new message.";

export function isStoppedRenderUiError(error: string | undefined): boolean {
  return error === STOPPED_ERROR || error === CANCELLED_ON_SEND_ERROR;
}

export type ToolRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type ToolRunPart =
  | { state: "input-streaming" | "input-available" }
  | { state: "output-available"; output: unknown }
  | { state: "output-error"; errorText?: string };

export function toolRunStatus(part: ToolRunPart, stopped = false, toolName?: string): ToolRunStatus {
  switch (part.state) {
    case "output-available":
      if (toolName === "render_ui" && part.output == null) return stopped ? "cancelled" : "running";
      if (part.output && typeof part.output === "object" && "ok" in part.output && part.output.ok === false) {
        return "error" in part.output && part.output.error === "Search was stopped" ? "cancelled" : "failed";
      }
      if (hasStoppedOutput(toolName, part.output)) return "cancelled";
      if (hasFailedOutput(toolName, part.output)) return "failed";
      if (part.output && typeof part.output === "object" && "isError" in part.output && part.output.isError === true) return "failed";
      return "succeeded";
    case "output-error":
      if (part.errorText === STOPPED_ERROR || part.errorText === "Code run was stopped") return "cancelled";
      if (toolName === "render_ui" && isStoppedRenderUiError(part.errorText)) return "cancelled";
      return "failed";
    case "input-streaming":
    case "input-available":
      return stopped ? "cancelled" : "running";
  }
}

export function toolCallRunStatus(props: Pick<ToolCallMessagePartProps, "status" | "result" | "isError"> & Partial<Pick<ToolCallMessagePartProps, "toolName">>): ToolRunStatus {
  let part: ToolRunPart;
  if (props.isError) {
    const error = props.result && typeof props.result === "object" && "error" in props.result && typeof props.result.error === "string" ? props.result.error : undefined;
    part = { state: "output-error", errorText: error };
  } else if (props.result !== undefined) {
    part = { state: "output-available", output: props.result };
  } else {
    part = { state: "input-available" };
  }
  return toolRunStatus(part, props.status.type !== "running", props.toolName);
}
