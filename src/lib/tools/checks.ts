import type Docker from "dockerode";
import { Redactor } from "../chat-errors";
import { redactionSecrets } from "../connections";
import { ollamaStatus } from "../memory/embed";
import { memoryCount, textMatchIdsOrThrow } from "../memory/store";
import type { UserId, Viewer } from "../policy";
import { runCode, sandboxDocker } from "../sandbox/run";
import { checkGithub } from "./github";
import type { TestableToolId } from "./metadata";
import { searchWeb, type SearchBackends } from "./search";
import {
  loadToolContext, recordToolCall, sanitizeToolError, thrownToolError, TOOL_ERRORS, toolSetup, toolViewFor,
  type ToolCheckResponse, type ToolSetup,
} from "./status";

export type ToolCheckDeps = {
  searchBackends?: SearchBackends;
  runCode: typeof runCode;
  docker: () => Docker;
  memoryCount: (userId: UserId) => number;
  /** Must throw when memories_fts is broken. */
  textMatchIds: (userId: UserId, query: string, limit: number) => string[];
  ollamaStatus: typeof ollamaStatus;
};

const defaults: ToolCheckDeps = { runCode, docker: sandboxDocker, memoryCount, textMatchIds: textMatchIdsOrThrow, ollamaStatus };

const CHECK_MS = 15_000;
const WAIT_MS = 10_000;
const OLLAMA_MS = 3_000;

type Context = ReturnType<typeof loadToolContext>;
type Check = { ok: true; summary: string } | { ok: false; error: string };

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

const timeouts: Record<TestableToolId, string> = {
  web_search: TOOL_ERRORS.searchTimedOut,
  run_code: TOOL_ERRORS.sandboxTimedOut,
  github: TOOL_ERRORS.githubTimedOut,
  memory: TOOL_ERRORS.memoryUnavailable,
};

// One real minimal call per tool. A check that throws falls back to the tool's fixed message in runToolCheck.
const checks: Record<TestableToolId, (context: Context, signal: AbortSignal, deps: ToolCheckDeps, redact: Redactor) => Promise<Check>> = {
  web_search: async ({ instance }, signal, deps, redact) => {
    const search = await searchWeb(instance, "orbit", signal, deps.searchBackends, redact);
    if (!search.ok) return { ok: false, error: search.error };
    return { ok: true, summary: counted(search.results.length, "result", "results") };
  },
  run_code: async (_context, signal, deps, redact) => {
    const run = deps.runCode(deps.docker(), { language: "python", code: "print(1)" }, signal, redact);
    try {
      const output = await run.result;
      if (output.timedOut) return { ok: false, error: TOOL_ERRORS.sandboxTimedOut };
      if (output.oomKilled) return { ok: false, error: TOOL_ERRORS.sandboxOutOfMemory };
      if (output.exitCode !== 0 || output.stdout.trim() !== "1") return { ok: false, error: TOOL_ERRORS.sandboxUnexpected };
      return { ok: true, summary: "Exit 0" };
    } finally {
      await run.cleanup;
    }
  },
  github: async ({ user }, signal) => {
    const checked = await checkGithub(user.id, user.github, {}, signal, redactionSecrets(user.id));
    return checked.ok ? { ok: true, summary: checked.login } : { ok: false, error: checked.error };
  },
  memory: async ({ user }, signal, deps) => {
    const count = deps.memoryCount(user.id);
    deps.textMatchIds(user.id, "orbit", 1);
    const ollama = await deps.ollamaStatus(OLLAMA_MS, { fresh: true, signal });
    return { ok: true, summary: counted(count, "memory", "memories") + (ollama.ok ? "" : " · Text search only") };
  },
};

/**
 * Runs one real call of the tool for the viewer, records the outcome in tool_status, and answers the updated row.
 * When `signal` aborts, it throws and records nothing. When the 15 second ceiling fires first, it records the
 * tool's timeout message.
 */
export async function runToolCheck(viewer: Viewer, id: TestableToolId, signal: AbortSignal, deps: Partial<ToolCheckDeps> = {}): Promise<ToolCheckResponse> {
  const started = performance.now();
  const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(CHECK_MS)]);
  const context = loadToolContext(viewer.id);
  const redact = new Redactor(context.instance, context.user.github, ...redactionSecrets(viewer.id));
  let check: Check;
  try {
    check = await checks[id](context, checkSignal, { ...defaults, ...deps }, redact);
  } catch (error) {
    if (signal.aborted) throw error;
    if (!checkSignal.aborted) console.warn("tool check failed", { tool: id, error: error instanceof Error ? error.name : "Error" });
    check = { ok: false, error: thrownToolError(id, error, { language: "python" }, redact) };
  }
  signal.throwIfAborted();
  if (!check.ok && checkSignal.aborted) check = { ok: false, error: timeouts[id] };
  const ms = Math.round(performance.now() - started);
  if (check.ok) {
    recordToolCall(viewer.id, id, { ok: true }, redact);
    return { ok: true, ms, summary: check.summary, tool: toolViewFor(viewer, id) };
  }
  const error = sanitizeToolError(check.error, redact);
  recordToolCall(viewer.id, id, { ok: false, error }, redact);
  return { ok: false, ms, error, tool: toolViewFor(viewer, id) };
}

type Slot = { inFlight: boolean; lastStartedAt: number };

// Route handlers and pages load separate copies of this module, so the slots live on globalThis.
const globalChecks = globalThis as typeof globalThis & { __orbitToolChecks?: Map<string, Slot> };
const slots = globalChecks.__orbitToolChecks ??= new Map();

export function resetToolCheckRateLimit() {
  slots.clear();
}

export type ToolCheckStart =
  | { ok: true; release: () => void }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 429; error: string; retryAfter: number };

function offMessage(id: TestableToolId, setup: ToolSetup, viewer: Viewer): string {
  switch (id) {
    case "web_search":
      return setup.state === "unreadable" && viewer.role === "admin" ? "Saved Tavily key is unreadable." : "Web search is not configured.";
    case "run_code":
      return setup.state === "server-off" ? "Code sandbox is off on this server." : "Code sandbox is turned off.";
    case "github":
      return setup.state === "unreadable" ? "Saved GitHub token is unreadable. Enter it again." : "Add a GitHub token.";
    case "memory":
      return "Memory is turned off.";
  }
}

/**
 * Claims the one check a viewer may run on a tool: it refuses a tool that is off, then a second check while one
 * runs or within 10 seconds of the last start. Call `release` when the check ends.
 */
export function startToolCheck(viewer: Viewer, id: TestableToolId, now = Date.now()): ToolCheckStart {
  const setup = toolSetup(id, loadToolContext(viewer.id));
  if (setup.state !== "ready") return { ok: false, status: 409, error: offMessage(id, setup, viewer) };
  const key = `${viewer.id}:${id}`;
  const last = slots.get(key);
  if (last && (last.inFlight || now - last.lastStartedAt < WAIT_MS)) {
    const retryAfter = Math.max(1, Math.ceil((last.lastStartedAt + WAIT_MS - now) / 1_000));
    return { ok: false, status: 429, error: "Wait a moment before testing again.", retryAfter };
  }
  const slot = { inFlight: true, lastStartedAt: now };
  slots.set(key, slot);
  return { ok: true, release: () => { slot.inFlight = false; } };
}
