"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { OrbitMark } from "@/components/orbit-mark";
import { RenderUiPart } from "@/components/genui/render-ui";
import { cardFor } from "@/lib/tools/metadata";
import { toolCallRunStatus, type ToolRunStatus } from "@/lib/tools/run-status";
import { SearchResults } from "./search-results";
import { GenericOutput } from "./generic-output";

const statusLabels: Record<ToolRunStatus, string> = {
  running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};

export function RunCard(props: ToolCallMessagePartProps) {
  const status = toolCallRunStatus(props);
  const kind = cardFor(props.toolName);
  return (
    <section data-tool-name={props.toolName} className="my-3 min-w-0 max-w-widget rounded-lg border bg-card shadow-card">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5 text-xs">
        {status === "running" && <OrbitMark busy tone="mono" className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-medium">{props.toolName === "web_search" ? "Web search" : props.toolName === "render_ui" ? "Generated UI" : props.toolName}</span>
        <span role="status" data-tool-status={status} className={status === "failed" ? "text-destructive" : "text-muted-foreground"}>{statusLabels[status]}</span>
      </div>
      {status !== "running" && status !== "cancelled" && (
        <div className="min-w-0 p-3">
          {kind === "genui" ? <RenderUiPart {...props} /> : props.isError ? <p className="text-sm text-destructive">Tool failed</p> : kind === "search" ? <SearchResults output={props.result} /> : <GenericOutput output={props.result} />}
        </div>
      )}
    </section>
  );
}
