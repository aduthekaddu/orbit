"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { z } from "zod";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { SyntaxHighlighter } from "@/components/chat/code-block";
import { OrbitMark } from "@/components/orbit-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { nextReload, requestJson, type Loaded, type RequestFailure } from "@/lib/request-json";
import { TOOL_IDS, type ToolId } from "@/lib/tools/metadata";
import type { ToolCheckResponse, ToolInspection, ToolView } from "@/lib/tools/status";
import { cn } from "@/lib/utils";
import { toolIcon } from "./tool-icon";

const configure = z.enum(["admin", "self"]);

const setupSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }),
  z.object({ state: z.literal("missing"), configure }),
  z.object({ state: z.literal("unreadable"), configure }),
  z.object({ state: z.literal("disabled"), configure }),
  z.object({ state: z.literal("server-off") }),
]);

const toolViewSchema: z.ZodType<ToolView> = z.object({
  id: z.enum(TOOL_IDS),
  label: z.string(),
  scope: z.enum(["instance", "personal", "built-in"]),
  setup: setupSchema,
  health: z.discriminatedUnion("state", [
    z.object({ state: z.literal("untested") }),
    z.object({ state: z.literal("working"), lastGoodAt: z.string() }),
    z.object({ state: z.literal("failing"), lastGoodAt: z.string().nullable(), failedAt: z.string(), error: z.string() }),
  ]),
  status: z.enum(["off", "ready", "untested", "working", "failing"]),
  canTest: z.boolean(),
  toggleable: z.boolean(),
  configureHref: z.string().nullable(),
});

const checkSchema: z.ZodType<ToolCheckResponse> = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ms: z.number(), summary: z.string(), tool: toolViewSchema }),
  z.object({ ok: z.literal(false), ms: z.number(), error: z.string(), tool: toolViewSchema }),
]);

const inspectionSchema: z.ZodType<ToolInspection> = z.object({
  id: z.enum(TOOL_IDS),
  setup: setupSchema,
  instruction: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })),
  error: z.string().optional(),
});

type TestRun =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "passed"; summary: string; ms: number }
  | { status: "failed"; error: string };

type ToolRow = { tool: ToolView; open: boolean; details: Loaded<ToolInspection>; test: TestRun };

type ToolsListStore = ReturnType<typeof createToolsList>;

const failureText = (failure: RequestFailure, fallback: string) => (failure.kind === "http" && failure.error) || fallback;

// A load that failed, or answered with the tool's own error, runs again when the row opens.
const needsLoad = (details: Loaded<ToolInspection>) =>
  details.status === "idle" || details.status === "failed" || (details.status === "done" && details.data.error !== undefined);

/** The /tools rows. `toggle`, `test`, and `retry` each settle once their request has. */
export function createToolsList(initial: ToolView[]) {
  let rows: readonly ToolRow[] = initial.map((tool) => ({ tool, open: false, details: { status: "idle" }, test: { status: "idle" } }));
  const listeners = new Set<() => void>();
  const loads = new Map<ToolId, AbortController>();

  const rowOf = (id: ToolId) => rows.find((row) => row.tool.id === id);

  function update(id: ToolId, change: (row: ToolRow) => ToolRow) {
    rows = rows.map((row) => (row.tool.id === id ? change(row) : row));
    for (const listener of listeners) listener();
  }

  function load(id: ToolId, from: (details: Loaded<ToolInspection>) => Loaded<ToolInspection> = () => ({ status: "pending" })) {
    loads.get(id)?.abort();
    const controller = new AbortController();
    loads.set(id, controller);
    update(id, (row) => ({ ...row, details: from(row.details) }));
    return requestJson(`/api/tools/${id}`, { signal: controller.signal }, {
      parse: inspectionSchema,
      onOk: (data) => update(id, (row) => ({ ...row, details: { status: "done", data } })),
      onFailed: (failure) => update(id, (row) => ({ ...row, details: { status: "failed", failure } })),
    });
  }

  // A Test that moves the tool's setup or health can change what the model gets, so the definitions load again.
  function reloadAfter(id: ToolId, before: ToolView, after: ToolView) {
    if (before.setup.state === after.setup.state && before.health.state === after.health.state) return;
    if (rowOf(id)?.open) {
      void load(id, nextReload);
      return;
    }
    loads.get(id)?.abort();
    update(id, (row) => ({ ...row, details: { status: "idle" } }));
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => rows,
    async toggle(id: ToolId) {
      const row = rowOf(id);
      if (!row) return;
      update(id, (current) => ({ ...current, open: !current.open }));
      if (!row.open && needsLoad(row.details)) await load(id);
    },
    async test(id: ToolId) {
      const row = rowOf(id);
      if (!row || row.test.status === "pending") return;
      update(id, (current) => ({ ...current, test: { status: "pending" } }));
      await requestJson(`/api/tools/${id}/test`, { method: "POST" }, {
        parse: checkSchema,
        onOk: (body) => {
          update(id, (current) => ({
            ...current,
            tool: body.tool,
            test: body.ok ? { status: "passed", summary: body.summary, ms: body.ms } : { status: "failed", error: body.error },
          }));
          reloadAfter(id, row.tool, body.tool);
        },
        onFailed: (failure) => update(id, (current) => ({ ...current, test: { status: "failed", error: failureText(failure, "Could not test.") } })),
      });
    },
    retry: (id: ToolId) => load(id),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `iso` was. A server clock a little ahead of the reader's still reads `now`. */
export function relativeTime(iso: string, nowMs: number) {
  const elapsed = nowMs - Date.parse(iso);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`;
  return `${Math.floor(elapsed / DAY)} d ago`;
}

// The reader's clock, read only in the browser so the server never prints its own. It ticks while the page is
// open, so `now` turns into `1 min ago`.
let clock: number | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  ticker ??= setInterval(() => {
    clock = Date.now();
    for (const notify of clockListeners) notify();
  }, 30_000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size > 0) return;
    clearInterval(ticker);
    ticker = undefined;
    clock = null;
  };
}

const readClock = () => (clock ??= Date.now());
const noClock = () => null;

function formatMs(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STATUS: Record<ToolView["status"], { word: string; dot: string }> = {
  working: { word: "Working", dot: "bg-positive" },
  ready: { word: "On", dot: "bg-positive" },
  failing: { word: "Failing", dot: "bg-destructive" },
  untested: { word: "Not tested", dot: "bg-muted-foreground/60" },
  off: { word: "Off", dot: "bg-muted-foreground/60" },
};

const UNREADABLE: Partial<Record<ToolId, string>> = { web_search: "Key unreadable", github: "Token unreadable" };

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex min-w-0 items-start gap-1.5 text-meta text-destructive">
      <WarningCircleIcon weight="regular" className="mt-0.75 size-3.5 shrink-0" />
      {children}
    </div>
  );
}

export function ToolsListView({ list }: { list: ToolsListStore }) {
  const rows = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot);
  return (
    <ul className="divide-y rounded-xl border bg-card shadow-card">
      {rows.map((row) => (
        <ToolRowItem key={row.tool.id} row={row} list={list} />
      ))}
    </ul>
  );
}

export function ToolsList({ initial }: { initial: ToolView[] }) {
  const [list] = useState(() => createToolsList(initial));
  return <ToolsListView list={list} />;
}

function ToolRowItem({ row, list }: { row: ToolRow; list: ToolsListStore }) {
  const { tool, open, test } = row;
  const id = useId();
  const triggerId = `${id}trigger`;
  const panelId = `${id}panel`;
  const now = useSyncExternalStore(subscribeClock, readClock, noClock);
  const Icon = toolIcon(tool.id);
  const status = STATUS[tool.status];
  const lastGoodAt = tool.health.state === "untested" ? null : tool.health.lastGoodAt;
  const pending = test.status === "pending";
  const error = test.status === "failed" ? test.error : tool.health.state === "failing" ? tool.health.error : null;
  const unreadable = tool.setup.state === "unreadable" ? UNREADABLE[tool.id] : undefined;

  let action: ReactNode = null;
  if (tool.canTest) {
    action = (
      <Button variant="outline" size="sm" disabled={pending} aria-busy={pending || undefined} onClick={() => void list.test(tool.id)} className="ml-auto max-sm:min-h-touch">
        {pending ? <OrbitMark busy tone="mono" className="size-3.5" /> : null}
        {pending ? "Testing" : "Test"}
      </Button>
    );
  } else if (tool.setup.state !== "ready" && tool.configureHref) {
    action = (
      <Button asChild variant="outline" size="sm" className="ml-auto max-sm:min-h-touch">
        <Link href={tool.configureHref}>Set up</Link>
      </Button>
    );
  }
  const time = lastGoodAt && now !== null ? (
    <time dateTime={lastGoodAt} className="num text-meta text-muted-foreground">
      {relativeTime(lastGoodAt, now)}
    </time>
  ) : null;

  return (
    <li data-tool-row={tool.id}>
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5 sm:py-3.5">
        <button
          type="button"
          id={triggerId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => void list.toggle(tool.id)}
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-focus focus-visible:ring-ring/50 max-sm:min-h-touch max-sm:w-full"
        >
          <CaretRightIcon
            weight="regular"
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-[rotate,color] duration-200 ease-orbit group-hover:text-foreground", open && "rotate-90")}
          />
          <Icon weight="regular" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{tool.label}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground max-sm:ml-auto">
            <span aria-hidden className={cn("size-1.5 rounded-full", status.dot)} />
            {status.word}
          </span>
        </button>
        {time || action ? (
          <div className="flex shrink-0 items-center gap-3">
            {time}
            {action}
          </div>
        ) : null}
      </div>
      {unreadable || error || test.status === "passed" ? (
        <div className="-mt-1 flex flex-col gap-1 px-4 pb-3 sm:pr-5 sm:pb-3.5 sm:pl-17.5">
          {unreadable ? <p className="text-meta text-destructive">{unreadable}</p> : null}
          {error ? (
            <Alert>
              <span className="min-w-0 wrap-anywhere">{error}</span>
            </Alert>
          ) : null}
          {test.status === "passed" ? (
            <p role="status" className="num text-meta text-muted-foreground">
              {test.summary} · {formatMs(test.ms)}
            </p>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div id={panelId} role="region" aria-labelledby={triggerId} className="px-4 pb-4 sm:pr-5 sm:pl-17.5">
          <ToolDetails row={row} list={list} />
        </div>
      ) : null}
    </li>
  );
}

function ToolDetails({ row, list }: { row: ToolRow; list: ToolsListStore }) {
  const { tool, details } = row;
  if (details.status === "idle" || details.status === "pending") {
    return (
      <div role="status" aria-label="Loading tool details" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  const configureLink = tool.setup.state === "ready" && tool.configureHref ? (
    <div className="flex justify-end">
      <Button asChild variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground max-sm:min-h-touch">
        <Link href={tool.configureHref}>Configure</Link>
      </Button>
    </div>
  ) : null;
  const error = details.status === "failed" ? failureText(details.failure, "Could not load tool details.") : details.data.error;
  if (details.status === "failed" || error !== undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Alert>
          <span className="min-w-0 flex-1 wrap-anywhere">{error}</span>
          <Button variant="outline" size="xs" className="max-sm:min-h-touch" onClick={() => void list.retry(tool.id)}>
            Retry
          </Button>
        </Alert>
        {configureLink}
      </div>
    );
  }
  const { instruction, tools } = details.data;
  if (tools.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-muted-foreground">Not sent to the model</p>
        {configureLink}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {tools.map((modelTool) => (
        <div key={modelTool.name} className="flex min-w-0 flex-col gap-1.5">
          <p className="font-mono text-sm font-medium break-all">{modelTool.name}</p>
          {modelTool.description ? <p className="text-meta text-muted-foreground">{modelTool.description}</p> : null}
          <SyntaxHighlighter standalone language="json" code={JSON.stringify(modelTool.inputSchema, null, 2)} />
        </div>
      ))}
      {instruction !== null ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-meta font-medium text-muted-foreground">System instruction</h3>
          <p className="rounded-lg border bg-surface-sunken px-3 py-2 text-meta whitespace-pre-wrap break-words">{instruction}</p>
        </div>
      ) : null}
      {configureLink}
    </div>
  );
}
