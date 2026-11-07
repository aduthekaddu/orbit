"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { OrbitMark } from "@/components/orbit-mark";
import { RenderUiPart } from "@/components/genui/render-ui";
import { hasStoppedCodeOutput, runCodeInputSchema } from "@/lib/sandbox/spec";
import { cardFor } from "@/lib/tools/metadata";
import { toolCallRunStatus, type ToolRunStatus } from "@/lib/tools/run-status";
import { SearchResults } from "./search-results";
import { GenericOutput } from "./generic-output";
import { GithubOutput } from "./github-output";
import { CodeRun } from "./code-run";
import type { ToolCardKind } from "@/lib/tools/metadata";

const statusLabels: Record<ToolRunStatus, string> = {
  running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};

const languageLabels = { python: "Python", javascript: "JavaScript" };

function toolTitle(name: string, kind: ToolCardKind) {
  if (kind === "github") return "GitHub";
  if (name === "web_search") return "Web search";
  if (name === "render_ui") return "Generated UI";
  if (name === "run_code") return "Run code";
  return name;
}

export function RunCard(props: ToolCallMessagePartProps) {
  const status = toolCallRunStatus(props);
  const kind = cardFor(props.toolName);
  const language = kind === "code" ? runCodeInputSchema.safeParse(props.args).data?.language : undefined;
  return (
    <section data-tool-name={props.toolName} className="my-3 min-w-0 max-w-widget rounded-lg border bg-card shadow-card">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5 text-xs">
        {status === "running" && <OrbitMark busy tone="mono" className="size-4 shrink-0" />}
        <span className="min-w-0 truncate font-medium">{toolTitle(props.toolName, kind)}</span>
        {language && <span className="shrink-0 rounded-sm border px-1.5 font-mono text-2xs leading-4 text-muted-foreground">{languageLabels[language]}</span>}
        <span role="status" data-tool-status={status} className={`ml-auto shrink-0 ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{statusLabels[status]}</span>
      </div>
      {(kind === "code" || status !== "running" && status !== "cancelled") && (
        <div className="min-w-0 p-3">
          {kind === "code" ? <CodeRun input={props.args} output={status === "cancelled" && !hasStoppedCodeOutput(props.result) ? undefined : props.result} /> : kind === "genui" ? <RenderUiPart {...props} /> : props.isError ? <p className="text-sm text-destructive">Tool failed</p> : kind === "search" ? <SearchResults output={props.result} /> : kind === "github" ? <GithubOutput output={props.result} /> : <GenericOutput output={props.result} />}
        </div>
      )}
    </section>
  );
}
