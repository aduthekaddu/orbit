"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useRunResultUnloaded } from "@/components/chat/stopped-run-sync";
import { OrbitMark } from "@/components/orbit-mark";
import { RenderUiPart } from "@/components/genui/render-ui";
import { runCodeInputSchema } from "@/lib/sandbox/spec";
import { layoutFor, titleFor } from "@/lib/tools/metadata";
import { toolCallRunEnd, type ToolRunEnd, type ToolRunStatus } from "@/lib/tools/run-status";
import { CodeRun } from "./code-run";
import { ToolLine } from "./tool-line";

const statusLabels: Record<ToolRunStatus, string> = {
  running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};

const statusColors: Record<ToolRunStatus, string> = {
  running: "text-muted-foreground", succeeded: "text-positive", failed: "text-destructive", cancelled: "text-muted-foreground",
};

const languageLabels = { python: "Python", javascript: "JavaScript" };
const RESULT_UNLOADED = { error: "Could not load output" };

function CodeCard({ props, end }: { props: ToolCallMessagePartProps; end: ToolRunEnd }) {
  const status = end.status;
  const language = runCodeInputSchema.safeParse(props.args).data?.language;
  const unloaded = useRunResultUnloaded(props.toolCallId);
  const output = end.status === "cancelled" ? (end.saved ?? (unloaded ? RESULT_UNLOADED : undefined)) : props.result;
  return (
    <section data-tool-name={props.toolName} className="my-3 min-w-0 max-w-chat rounded-lg border bg-card shadow-card">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5 text-meta">
        {status === "running" && <OrbitMark busy tone="mono" className="size-4 shrink-0" />}
        <span className="min-w-0 truncate font-medium">{titleFor(props.toolName)}</span>
        {language && <span className="shrink-0 rounded-sm border px-1.5 font-mono text-meta text-muted-foreground">{languageLabels[language]}</span>}
        <span role="status" data-tool-status={status} className={`ml-auto shrink-0 ${statusColors[status]}`}>{statusLabels[status]}</span>
      </div>
      <div className="min-w-0 p-3">
        <CodeRun input={props.args} output={output} />
      </div>
    </section>
  );
}

export function RunCard(props: ToolCallMessagePartProps) {
  const end = toolCallRunEnd(props);
  switch (layoutFor(props.toolName)) {
    case "inline":
      return <RenderUiPart {...props} />;
    case "line":
      return <ToolLine props={props} end={end} />;
    case "card":
      return <CodeCard props={props} end={end} />;
  }
}
