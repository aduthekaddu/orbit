"use client";

import { JSONUIProvider, Renderer, createStateStore } from "@json-render/react";
import type { Spec } from "@json-render/core";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { Component, useMemo, type ReactNode } from "react";
import { registry } from "@/components/genui/registry";
import { parseRenderSpec, type RenderOutcome } from "@/lib/genui/spec";
import { STOPPED_ERROR } from "@/lib/tools/run-status";

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

function Fallback({ error, raw }: { error: string; raw: unknown }) {
  const text = pretty(raw);
  return (
    <div data-genui-fallback className="rounded-xl border border-destructive/40 bg-card p-3 text-sm text-card-foreground">
      <p className="whitespace-pre-wrap text-destructive">{error}</p>
      {text ? <pre className="mt-2 overflow-x-auto text-xs">{text}</pre> : null}
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

function errorText(result: unknown) {
  if (result && typeof result === "object" && "error" in result && typeof result.error === "string" && result.error.trim()) {
    return result.error;
  }
  return "The spec was rejected";
}

export function RenderUiPart({ result, args, argsText, status, isError, toolCallId }: ToolCallMessagePartProps) {
  if (status.type === "running" && result == null && !isError) {
    return <p className="text-sm text-muted-foreground">Building</p>;
  }

  if (status.type !== "running" && result == null && !isError) {
    return <StoppedFallback />;
  }

  if (isError) {
    const error = errorText(result);
    return error === STOPPED_ERROR ? <StoppedFallback /> : <Fallback error={error} raw={argsText || args} />;
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
          <SpecView spec={checked.spec} />
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
