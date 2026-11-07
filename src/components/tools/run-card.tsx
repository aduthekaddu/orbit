"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { OrbitMark } from "@/components/orbit-mark";
import { RenderUiPart } from "@/components/genui/render-ui";
import { hasStoppedCodeOutput, runCodeInputSchema } from "@/lib/sandbox/spec";
import { cardFor } from "@/lib/tools/metadata";
import { toolCallRunStatus, type ToolRunStatus } from "@/lib/tools/run-status";
import { SearchResults } from "./search-results";
import { GenericOutput } from "./generic-output";
import { CodeRun } from "./code-run";

const statusLabels: Record<ToolRunStatus, string> = {
  running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};

const languageLabels = { python: "Python", javascript: "JavaScript" };

function rememberedText(args: unknown, result: unknown): string {
  if (result && typeof result === "object" && "text" in result && typeof result.text === "string" && result.text.trim()) return result.text;
  if (args && typeof args === "object" && "text" in args && typeof args.text === "string") return args.text;
  return "";
}

export function RunCard(props: ToolCallMessagePartProps) {
  const status = toolCallRunStatus(props);
  const kind = cardFor(props.toolName);
  const savedText = props.toolName === "remember" && status !== "failed" ? rememberedText(props.args, props.result) : "";
  const language = kind === "code" ? runCodeInputSchema.safeParse(props.args).data?.language : undefined;
  return (
    <section data-tool-name={props.toolName} className="my-3 min-w-0 max-w-widget rounded-lg border bg-card shadow-card">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5 text-xs">
        {status === "running" && <OrbitMark busy tone="mono" className="size-4 shrink-0" />}
        <span className="min-w-0 truncate font-medium">{props.toolName === "web_search" ? "Web search" : props.toolName === "render_ui" ? "Generated UI" : props.toolName === "run_code" ? "Run code" : props.toolName}</span>
        {language && <span className="shrink-0 rounded-sm border px-1.5 font-mono text-2xs leading-4 text-muted-foreground">{languageLabels[language]}</span>}
        <span role="status" data-tool-status={status} className={`ml-auto shrink-0 ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{statusLabels[status]}</span>
      </div>
      {(kind === "code" || status !== "running" && status !== "cancelled") && (
        <div className="min-w-0 p-3">
          {kind === "code" ? <CodeRun input={props.args} output={status === "cancelled" && !hasStoppedCodeOutput(props.result) ? undefined : props.result} /> : kind === "genui" ? <RenderUiPart {...props} /> : props.isError ? <p className="text-sm text-destructive">Tool failed</p> : kind === "search" ? <SearchResults output={props.result} /> : savedText ? <p className="break-words text-sm text-foreground">{savedText}</p> : <GenericOutput output={props.result} />}
        </div>
      )}
    </section>
  );
}
