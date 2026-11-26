"use client";

import { JSONUIProvider, Renderer, createStateStore } from "@json-render/react";
import type { Spec } from "@json-render/core";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Component, useMemo, type ReactNode } from "react";
import { disclosureBody, disclosureTrigger } from "@/components/chat/disclosure";
import { registry } from "@/components/genui/registry";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Skeleton } from "@/components/ui/skeleton";
import { parseRenderSpec, type RenderOutcome } from "@/lib/genui/spec";
import { toolCallRunEnd, type ToolRunEnd } from "@/lib/tools/run-status";
import { cn } from "@/lib/utils";

function pretty(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function StoppedFallback() {
  return <p data-genui-fallback className="text-sm text-muted-foreground">Stopped</p>;
}

/** A spec that cannot be drawn: one line, with the error and the raw JSON one tap away. */
function Fallback({ error, raw }: { error: string; raw: unknown }) {
  const text = pretty(raw);
  return (
    <details data-genui-fallback className="group/line min-w-0">
      <summary className={cn(disclosureTrigger, "w-fit text-destructive hover:text-destructive")}>
        <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
        <span className="truncate">Could not show this view</span>
        <span className="text-muted-foreground">Details</span>
        <CaretRightIcon weight="regular" className="size-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-orbit group-open/line:rotate-90" />
      </summary>
      <div className={disclosureBody}>
        <p className="text-meta whitespace-pre-wrap break-words text-destructive">{error}</p>
        {text ? (
          <ScrollFade axis="y" fade="var(--surface-sunken)" className="mt-2 rounded-md bg-surface-sunken" scrollerClassName="max-h-tool-content" scrollerLabel="Spec">
            <pre className="p-3 font-mono text-code whitespace-pre-wrap break-words text-foreground">{text}</pre>
          </ScrollFade>
        ) : null}
      </div>
    </details>
  );
}

const surface = "rounded-xl border bg-card p-4 text-card-foreground shadow-card max-sm:p-3";

function Building() {
  return (
    <div data-genui className={surface}>
      <span role="status" className="sr-only">Building view</span>
      <Skeleton className="h-5 w-2/5" />
      <Skeleton className="mt-4 h-3.5 w-full" />
      <Skeleton className="mt-2.5 h-3.5 w-11/12" />
      <Skeleton className="mt-2.5 h-3.5 w-3/5" />
    </div>
  );
}

class RenderBoundary extends Component<{ children: ReactNode; raw: unknown }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : "The spec could not be drawn" };
  }

  render() {
    if (this.state.error) return <Fallback error={this.state.error} raw={this.props.raw} />;
    return this.props.children;
  }
}

export function SpecView({ spec }: { spec: Spec }) {
  const store = useMemo(() => createStateStore({ note: "" }), []);
  return (
    <JSONUIProvider registry={registry} store={store}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}

function readOutcome(result: unknown): RenderOutcome | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { ok?: unknown; spec?: unknown; error?: unknown; raw?: unknown };
  if (record.ok === true) return { ok: true, spec: record.spec as Spec };
  if (record.ok === false && typeof record.error === "string") {
    return { ok: false, error: record.error, raw: record.raw };
  }
  return null;
}

/** A generated view renders in the reply itself: one surface, no run frame, no status word. */
export function RenderUiPart(props: ToolCallMessagePartProps) {
  const end = toolCallRunEnd(props);
  return (
    <div data-tool-name={props.toolName} data-tool-status={end.status} className="my-3 min-w-0 max-w-chat">
      <View props={props} end={end} />
    </div>
  );
}

function View({ props, end }: { props: ToolCallMessagePartProps; end: ToolRunEnd }) {
  const { result, args, argsText, status, toolCallId } = props;
  if (end.status === "running") return <Building />;
  if (end.status === "cancelled") return <StoppedFallback />;
  if (end.status === "failed" && end.error !== undefined) {
    return <Fallback error={end.error.trim() ? end.error : "The spec was rejected"} raw={argsText || args} />;
  }

  const outcome = readOutcome(result);
  if (outcome?.ok === false) {
    return <Fallback error={outcome.error} raw={outcome.raw ?? argsText ?? args} />;
  }

  const candidate = outcome?.ok ? outcome.spec : status.type === "complete" ? args : null;
  if (candidate) {
    const checked = parseRenderSpec(candidate);
    if (checked.ok) {
      return (
        <RenderBoundary key={toolCallId} raw={checked.spec}>
          <div data-genui className={surface}>
            <SpecView spec={checked.spec} />
          </div>
        </RenderBoundary>
      );
    }
    return <Fallback error={checked.error} raw={checked.raw} />;
  }

  if (status.type === "incomplete") {
    return <StoppedFallback />;
  }

  return <Fallback error="No tool result" raw={argsText || args} />;
}
