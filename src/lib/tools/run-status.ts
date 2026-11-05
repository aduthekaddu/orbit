export type ToolRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type ToolRunPart =
  | { state: "input-streaming" | "input-available" }
  | { state: "output-available"; output: unknown }
  | { state: "output-error"; errorText?: string };

export function toolRunStatus(_part: ToolRunPart, _stopped = false): ToolRunStatus {
  return "running";
}
