import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { hasFailedOutput } from "./metadata";

export type ToolRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type ToolRunPart =
  | { state: "input-streaming" | "input-available" }
  | { state: "output-available"; output: unknown }
  | { state: "output-error"; errorText?: string };

export function toolRunStatus(part: ToolRunPart, stopped = false, toolName?: string): ToolRunStatus {
  switch (part.state) {
    case "output-available":
      if (part.output && typeof part.output === "object" && "ok" in part.output && part.output.ok === false) {
        return "error" in part.output && part.output.error === "Search was stopped" ? "cancelled" : "failed";
      }
      if (hasFailedOutput(toolName, part.output)) return "failed";
      return "succeeded";
    case "output-error":
      return part.errorText === "Stopped" ? "cancelled" : "failed";
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
