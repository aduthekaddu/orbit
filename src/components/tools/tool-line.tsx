"use client";

import type { ReactNode } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { BookmarkSimpleIcon, CaretRightIcon, GithubLogoIcon, MagnifyingGlassIcon, WarningCircleIcon, WrenchIcon, type Icon } from "@phosphor-icons/react";
import { disclosureBody, disclosureTrigger } from "@/components/chat/disclosure";
import { OrbitMark } from "@/components/orbit-mark";
import { cardFor, summaryFor, type ToolCardKind } from "@/lib/tools/metadata";
import type { ToolRunEnd } from "@/lib/tools/run-status";
import { searchSources } from "@/lib/tools/search-output";
import { cn } from "@/lib/utils";
import { GenericOutput } from "./generic-output";
import { GithubOutput } from "./github-output";
import { DomainTile, SearchResults } from "./search-results";

type LineKind = Exclude<ToolCardKind, "genui" | "code">;

const icons: Record<LineKind, Icon> = {
  search: MagnifyingGlassIcon,
  github: GithubLogoIcon,
  memory: BookmarkSimpleIcon,
  generic: WrenchIcon,
};

const MAX_TILES = 5;

function textField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || !(key in value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field.trim() : "";
}

function Failure({ text }: { text: string }) {
  return <p className="text-sm break-words text-destructive">{text}</p>;
}

function bodyFor(kind: LineKind, props: ToolCallMessagePartProps, end: ToolRunEnd): ReactNode {
  if (end.status === "running" || end.status === "cancelled") return null;
  if (end.status === "failed" && end.error !== undefined) return <Failure text={end.error.trim() || "The tool failed"} />;
  switch (kind) {
    case "search":
      return end.status === "succeeded" && searchSources(props.result).length === 0 ? null : <SearchResults output={props.result} />;
    case "github":
      return <GithubOutput output={props.result} input={props.args} />;
    case "memory": {
      const error = textField(props.result, "error");
      return end.status === "failed" ? <Failure text={error || "The memory was not changed"} /> : null;
    }
    case "generic":
      return <GenericOutput output={props.result} />;
  }
}

/** The text a memory line shows after its label: what was saved. */
function detailFor(props: ToolCallMessagePartProps, end: ToolRunEnd) {
  if (props.toolName !== "remember" || end.status === "failed" || end.status === "cancelled") return "";
  return textField(props.result, "text") || textField(props.args, "text");
}

/** A tool call as one line that says what happened. It opens on tap when there is more to read, and a failure starts open. */
export function ToolLine({ props, end }: { props: ToolCallMessagePartProps; end: ToolRunEnd }) {
  const kind = cardFor(props.toolName) as LineKind;
  const summary = summaryFor(props.toolName, { status: end.status, input: props.args, output: props.result });
  const failed = end.status === "failed";
  const body = bodyFor(kind, props, end);
  const detail = detailFor(props, end);
  const sources = end.status === "succeeded" && kind === "search" ? searchSources(props.result).slice(0, MAX_TILES) : [];
  const KindIcon = failed ? WarningCircleIcon : icons[kind];

  const line = (
    <>
      {end.status === "running" ? (
        <OrbitMark busy tone="mono" className="size-3.5 shrink-0" />
      ) : (
        <KindIcon weight="regular" className="size-3.5 shrink-0" />
      )}
      <span role="status" data-tool-status={end.status} className="min-w-0 shrink truncate">
        {summary}
      </span>
      {detail && (
        <span data-tool-detail className="min-w-0 max-w-[24ch] shrink-[2] truncate text-foreground sm:max-w-[40ch]">
          {detail}
        </span>
      )}
      {sources.length > 0 && (
        <span className="ml-0.5 flex shrink-0 -space-x-1.5 max-sm:[&>:nth-child(n+4)]:hidden">
          {sources.map((source) => (
            <DomainTile key={source.url} url={source.url} className="size-5 rounded-full text-meta leading-none ring-2 ring-surface-sunken" />
          ))}
        </span>
      )}
      {body && <CaretRightIcon weight="regular" className="size-3 shrink-0 transition-transform duration-200 ease-orbit group-open/line:rotate-90" />}
    </>
  );
  const pill = cn(disclosureTrigger, "w-fit", failed && "text-destructive hover:text-destructive");

  if (!body) {
    return (
      <div data-tool-name={props.toolName} className="my-2 min-w-0">
        <div className={cn(pill, "cursor-default hover:border-border hover:text-muted-foreground", failed && "hover:text-destructive")}>{line}</div>
      </div>
    );
  }
  return (
    <details data-tool-name={props.toolName} open={failed} className="group/line my-2 min-w-0">
      <summary className={cn(pill, "group-open/line:text-foreground", failed && "group-open/line:text-destructive")}>{line}</summary>
      <div className={disclosureBody}>{body}</div>
    </details>
  );
}
