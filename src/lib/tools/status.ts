import { and, eq } from "drizzle-orm";
import type { Tool } from "ai";
import { z } from "zod";
import { REDACTED, Redactor } from "../chat-errors";
import { redactionSecrets } from "../connections";
import { getDb } from "../db";
import { toolStatus } from "../db/schema";
import { getInstance, type InstanceSettingsRecord } from "../instance-settings";
import type { UserId, Viewer } from "../policy";
import { getMemoryEnabled } from "../preferences";
import { sandboxEnabled } from "../sandbox/enabled";
import { runCodeInputSchema, runCodeOutputSchema } from "../sandbox/spec";
import { getGithub, type UserGithubRecord } from "../user-github";
import { githubFailureText } from "./github";
import { memoryStorageFailed } from "./memory";
import { TOOL_CATALOG, TOOL_IDS, type TestableToolId, type ToolId, type ToolScope } from "./metadata";
import { SANDBOX_FAILURES, sandboxFailureMessage, sandboxImageMissing } from "./run-code";
import { toolRunEnd } from "./run-status";
import { parseSearchRun } from "./search-output";

export type ToolSetupInput = {
  instance: Pick<InstanceSettingsRecord, "searxngUrl" | "tavilyApiKey" | "sandbox"> &
    Partial<Pick<InstanceSettingsRecord, "tavilyKeySet" | "tavilyKeyReadable">>;
  /** Defaults to sandboxEnabled(). */
  sandboxEnvOn?: boolean;
  user: {
    memory: boolean;
    github: Pick<UserGithubRecord, "githubToken"> & Partial<Pick<UserGithubRecord, "githubTokenSet" | "githubTokenReadable">>;
  };
};

export type ToolSetup =
  | { state: "ready" }
  | { state: "missing"; configure: "admin" | "self" }
  | { state: "unreadable"; configure: "admin" | "self" }
  | { state: "disabled"; configure: "admin" | "self" }
  | { state: "server-off" };

export type ToolHealth =
  | { state: "untested" }
  | { state: "working"; lastGoodAt: string }
  | { state: "failing"; lastGoodAt: string | null; failedAt: string; error: string };

export type ToolStatus = "off" | "ready" | "untested" | "working" | "failing";

export type ToolView = {
  id: ToolId;
  label: string;
  scope: ToolScope;
  setup: ToolSetup;
  health: ToolHealth;
  status: ToolStatus;
  canTest: boolean;
  toggleable: boolean;
  configureHref: string | null;
};

export type ModelToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolInspection = {
  id: ToolId;
  setup: ToolSetup;
  instruction: string | null;
  tools: ModelToolSchema[];
  error?: string;
};

export type ToolCheckResponse =
  | { ok: true; ms: number; summary: string; tool: ToolView }
  | { ok: false; ms: number; error: string; tool: ToolView };

export type ToolCallOutcome = { ok: true } | { ok: false; error: string };

type ToolStatusRow = typeof toolStatus.$inferSelect;

export const TOOL_ERRORS = {
  searchTimedOut: "Search timed out",
  searchUnavailable: "Search is unavailable",
  sandboxTimedOut: "Code sandbox timed out.",
  sandboxOutOfMemory: "Code sandbox out of memory.",
  sandboxUnexpected: "Code sandbox returned unexpected output.",
  githubTimedOut: "GitHub timed out.",
  githubCallFailed: "GitHub tool call failed.",
  memoryUnavailable: "Memory storage is unavailable.",
  checkFailed: "Tool check failed.",
} as const;

// Every message a check or a recorded call may store as it is. Anything else is cleaned first.
const FIXED_ERRORS = new Set<string>([
  ...Object.values(TOOL_ERRORS),
  ...Object.values(SANDBOX_FAILURES),
  ...runCodeInputSchema.shape.language.options.map(sandboxImageMissing),
  "Saved GitHub token is unreadable. Enter it again.",
  "Add a GitHub token.",
  "GitHub MCP URL is not allowed.",
  "GitHub rejected the token (bad request).",
  "GitHub rejected the token.",
  "GitHub did not return a login.",
  "GitHub is unavailable.",
]);

const URLS = /\b[a-z][a-z\d+.-]*:\/\/\S*/gi;
const MAX_ERROR = 200;

export function toolSetup(id: ToolId, input: ToolSetupInput): ToolSetup {
  const { instance, user } = input;
  switch (id) {
    case "web_search":
      if (instance.searxngUrl || instance.tavilyApiKey) return { state: "ready" };
      return { state: instance.tavilyKeySet && instance.tavilyKeyReadable === false ? "unreadable" : "missing", configure: "admin" };
    case "run_code":
      if (!(input.sandboxEnvOn ?? sandboxEnabled())) return { state: "server-off" };
      return instance.sandbox === "on" ? { state: "ready" } : { state: "disabled", configure: "admin" };
    case "github":
      if (user.github.githubToken) return { state: "ready" };
      return { state: user.github.githubTokenSet && user.github.githubTokenReadable === false ? "unreadable" : "missing", configure: "self" };
    case "memory":
      return user.memory ? { state: "ready" } : { state: "disabled", configure: "self" };
    case "render_ui":
      return { state: "ready" };
  }
}

function toolHealth(row: ToolStatusRow | undefined): ToolHealth {
  const lastOkAt = row?.lastOkAt ?? null;
  const lastFailedAt = row?.lastFailedAt ?? null;
  if (lastFailedAt && (!lastOkAt || lastFailedAt.getTime() >= lastOkAt.getTime())) {
    return { state: "failing", lastGoodAt: lastOkAt?.toISOString() ?? null, failedAt: lastFailedAt.toISOString(), error: row?.lastError ?? TOOL_ERRORS.checkFailed };
  }
  return lastOkAt ? { state: "working", lastGoodAt: lastOkAt.toISOString() } : { state: "untested" };
}

function configureHref(id: ToolId, setup: ToolSetup, viewer: Pick<Viewer, "role">): string | null {
  const admin = viewer.role === "admin";
  switch (id) {
    case "web_search":
      return admin ? "/admin#search" : null;
    case "run_code":
      return admin && setup.state !== "server-off" ? "/admin#sandbox" : null;
    case "github":
      return "/settings#github";
    case "memory":
      return "/settings#memory";
    case "render_ui":
      return null;
  }
}

export function toolView(id: ToolId, input: ToolSetupInput, row: ToolStatusRow | undefined, viewer: Pick<Viewer, "role">): ToolView {
  const { label, scope, testable, toggleable } = TOOL_CATALOG[id];
  const rawSetup = toolSetup(id, input);
  // A member cannot fix the instance key, so the key's state stays an admin detail, as in POST /api/chat.
  const setup: ToolSetup = id === "web_search" && rawSetup.state === "unreadable" && viewer.role !== "admin"
    ? { state: "missing", configure: "admin" }
    : rawSetup;
  const health = testable ? toolHealth(row) : { state: "untested" as const };
  const status: ToolStatus = rawSetup.state !== "ready" ? "off" : testable ? health.state : "ready";
  return { id, label, scope, setup, health, status, canTest: testable && rawSetup.state === "ready", toggleable, configureHref: configureHref(id, rawSetup, viewer) };
}

/** What every tool reads for one account: the instance, the account's GitHub settings, and its memory switch. */
export function loadToolContext(userId: UserId) {
  return { instance: getInstance(), user: { id: userId, memory: getMemoryEnabled(userId), github: getGithub(userId) } };
}

/** The viewer's tools in page order. Reads SQLite only; it never opens GitHub MCP or calls a backend. */
export function listToolViews(viewer: Viewer): ToolView[] {
  const context = loadToolContext(viewer.id);
  const rows = getDb().select().from(toolStatus).where(eq(toolStatus.userId, viewer.id)).all();
  return TOOL_IDS.map((id) => toolView(id, context, rows.find((row) => row.toolId === id), viewer));
}

export function toolViewFor(viewer: Viewer, id: ToolId): ToolView {
  const row = getDb().select().from(toolStatus).where(and(eq(toolStatus.userId, viewer.id), eq(toolStatus.toolId, id))).get();
  return toolView(id, loadToolContext(viewer.id), row, viewer);
}

/** A stored error: a fixed message as it is, anything else without credentials or URLs and capped at 200 characters. */
export function sanitizeToolError(message: string, redact: Redactor): string {
  if (FIXED_ERRORS.has(message)) return message;
  const safe = redact.diagnostic(message);
  const text = safe.replace(URLS, "").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);
  return safe === REDACTED || !text ? TOOL_ERRORS.checkFailed : text;
}

function savedSecrets(userId: UserId) {
  return new Redactor(getInstance(), getGithub(userId), ...redactionSecrets(userId));
}

/** Records a call's outcome for one account. A write that fails, such as for an account deleted mid-reply, only logs. */
export function recordToolCall(userId: UserId, toolId: TestableToolId, outcome: ToolCallOutcome, redact?: Redactor) {
  try {
    const now = new Date();
    const values = outcome.ok
      ? { lastOkAt: now, lastFailedAt: null, lastError: null }
      : { lastFailedAt: now, lastError: sanitizeToolError(outcome.error, redact ?? savedSecrets(userId)) };
    getDb().insert(toolStatus).values({ userId, toolId, ...values })
      .onConflictDoUpdate({ target: [toolStatus.userId, toolStatus.toolId], set: values }).run();
  } catch (error) {
    console.warn("tool status write failed", { tool: toolId, error: error instanceof Error ? error.name : "Error" });
  }
}

const failureText = z.object({ error: z.string() });

function fixedOr(output: unknown, fallback: string): string {
  const parsed = failureText.safeParse(output);
  return parsed.success && FIXED_ERRORS.has(parsed.data.error) ? parsed.data.error : fallback;
}

// A failed result proves the backend answered unless it is an infrastructure failure, so a model's bad input does
// not mark a healthy tool Failing.
function resultOutcome(toolId: TestableToolId, modelToolName: string, output: unknown): ToolCallOutcome | null {
  const end = toolRunEnd({ state: "output-available", output }, false, modelToolName);
  if (end.status === "cancelled" || end.status === "running") return null;
  if (end.status === "succeeded") return { ok: true };
  switch (toolId) {
    case "run_code":
      return runCodeOutputSchema.safeParse(output).success ? { ok: true } : { ok: false, error: fixedOr(output, SANDBOX_FAILURES.failed) };
    case "memory":
      return memoryStorageFailed(output) ? { ok: false, error: TOOL_ERRORS.memoryUnavailable } : { ok: true };
    case "web_search": {
      const search = parseSearchRun(output);
      return { ok: false, error: search.state === "failed" ? fixedOr(search, TOOL_ERRORS.searchUnavailable) : TOOL_ERRORS.searchUnavailable };
    }
    case "github":
      return { ok: false, error: TOOL_ERRORS.githubCallFailed };
  }
}

/** The fixed message for a call of a testable tool that threw. */
export function thrownToolError(toolId: TestableToolId, error: unknown, input: unknown, redact: Redactor): string {
  switch (toolId) {
    case "web_search":
      return TOOL_ERRORS.searchUnavailable;
    case "run_code":
      return sandboxFailureMessage(error, runCodeInputSchema.safeParse(input).data?.language ?? "python");
    case "github":
      return githubFailureText(error, redact);
    case "memory":
      return TOOL_ERRORS.memoryUnavailable;
  }
}

/** Records each real call of a testable tool in tool_status for its account, and passes the call through unchanged. */
export function recordingTool(tool: Tool, modelToolName: string, toolId: TestableToolId, userId: UserId, redact: Redactor): Tool {
  const execute = tool.execute?.bind(tool);
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (input, options) => {
      let output: unknown;
      try {
        output = await execute(input, options);
      } catch (error) {
        const aborted = options.abortSignal?.aborted || error instanceof Error && error.name === "AbortError";
        if (!aborted) recordToolCall(userId, toolId, { ok: false, error: thrownToolError(toolId, error, input, redact) }, redact);
        throw error;
      }
      if (options.abortSignal?.aborted) return output;
      const outcome = resultOutcome(toolId, modelToolName, output);
      if (outcome) recordToolCall(userId, toolId, outcome, redact);
      return output;
    },
  };
}
