import { createHash } from "node:crypto";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { REDACTED, Redactor, resolveMaskedUrl, type StoredCredentials } from "../chat-errors";
import type { ConnectionSecrets } from "../connections";
import type { UserId } from "../policy";
import type { UserGithubRecord } from "../user-github";
import { githubLogin } from "./github-links";

export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_TOOLSETS = "repos,issues,pull_requests";
export const GITHUB_CHECK_TOOLS = "get_me";
const GITHUB_MCP_HOSTS = new Set(["api.githubcopilot.com", "github.com", "api.github.com"]);
const GITHUB_MCP_URL_ERROR = "GitHub MCP URL is not allowed.";

export class GithubMcpUrlError extends Error {
  constructor() {
    super(GITHUB_MCP_URL_ERROR);
    this.name = "GithubMcpUrlError";
  }
}
const LIST_CACHE_MS = 5 * 60 * 1000;
const GITHUB_SETUP_MS = 10_000;
const GITHUB_CLOSE_MS = 5_000;
const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const PREFIX = "github_";

export type GithubSettings = StoredCredentials & { githubToken: string; githubMcpUrl: string };

export type McpToolSet = {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
  /** The safe githubFailureText of a connection that failed to open. */
  error?: string;
};

type ListPage = Awaited<ReturnType<MCPClient["listTools"]>>;

type CachedList = { expires: number; definitions: ListPage; shapes: Record<string, Tool> };

const globalTools = globalThis as typeof globalThis & { __orbitGithubToolLists?: Map<string, Map<string, CachedList>> };
const listCaches = globalTools.__orbitGithubToolLists ??= new Map();

export function clearGithubToolCache(userId: string) {
  listCaches.delete(userId);
}

export function resolveGithubMcpUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || DEFAULT_GITHUB_MCP_URL;
}

export function githubMcpTarget(value: string | undefined, env: NodeJS.ProcessEnv = process.env): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(resolveGithubMcpUrl(value));
  } catch {
    return { ok: false, error: GITHUB_MCP_URL_ERROR };
  }
  if (url.username || url.password) return { ok: false, error: GITHUB_MCP_URL_ERROR };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (env.ORBIT_GITHUB_MCP_FIXTURE === "1" && loopback && (url.protocol === "http:" || url.protocol === "https:")) {
    return { ok: true, url: url.toString() };
  }
  if (url.protocol !== "https:" || url.port || !GITHUB_MCP_HOSTS.has(host)) return { ok: false, error: GITHUB_MCP_URL_ERROR };
  return { ok: true, url: url.toString() };
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const status = error.statusCode;
  return typeof status === "number" ? status : undefined;
}

export function githubFailureText(error: unknown, redact: Redactor): string {
  const status = httpStatus(error);
  const message = redact.text(error instanceof Error ? error.message : "GitHub tools unavailable");
  if (status === 400 || /\bHTTP 400\b/i.test(message)) return "GitHub rejected the token (bad request).";
  if (status === 401 || status === 403 || /401|403|unauthorized|forbidden/i.test(message)) return "GitHub rejected the token.";
  return "GitHub is unavailable.";
}

function redactTool(tool: Tool, redact: Redactor): Tool {
  const execute = tool.execute?.bind(tool);
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (input, options) => {
      try {
        return redact.value(await execute(input, options));
      } catch (error) {
        if (error instanceof Error) throw new Error(redact.diagnostic(error.message));
        throw error;
      }
    },
  };
}

function emptySet(): McpToolSet {
  return { tools: {}, close: async () => {} };
}

function prefixedTools(raw: Record<string, Tool>, redact: Redactor): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(raw)) {
    tools[name.startsWith(PREFIX) ? name : `${PREFIX}${name}`] = redactTool(tool, redact);
  }
  return tools;
}

type McpConnection = {
  ready: Promise<MCPClient>;
  close: () => Promise<void>;
};

type ConnectState =
  | { kind: "connecting" }
  | { kind: "ready"; client: MCPClient }
  | { kind: "closed"; cleanup: Promise<void> };

type SessionState =
  | { kind: "none" }
  | { kind: "open"; id: string; protocolVersion: string }
  | { kind: "deleting"; promise: Promise<void> }
  | { kind: "deleted" };

type WarmState =
  | { kind: "idle" }
  | { kind: "started"; connection: McpConnection; tools: Promise<Record<string, Tool>> }
  | { kind: "closed"; cleanup: Promise<void> };

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("GitHub MCP connection was aborted.");
  error.name = "AbortError";
  return error;
}

function rpcMethod(body: RequestInit["body"]): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "method" in parsed && typeof parsed.method === "string") {
      return parsed.method;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function headerValue(headers: RequestInit["headers"], name: string): string | undefined {
  return headers ? (new Headers(headers).get(name) ?? undefined) : undefined;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    if (onLateValue) promise.then(onLateValue, () => {});
    else promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

async function readNegotiatedProtocol(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  try {
    const data: unknown = await response.json();
    if (
      data &&
      typeof data === "object" &&
      "result" in data &&
      data.result &&
      typeof data.result === "object" &&
      "protocolVersion" in data.result &&
      typeof data.result.protocolVersion === "string"
    ) {
      return data.result.protocolVersion;
    }
  } catch {
    await response.body?.cancel().catch(() => {});
  }
  return undefined;
}

// @ai-sdk/mcp passes its aborted initialization signal into transport.close(), which skips DELETE.
// Own the handshake stop path so a session created before or during initialize is still closed.
function openMcpClient(input: {
  url: string;
  headers: Record<string, string>;
  setupMs: number;
  signal?: AbortSignal;
}): McpConnection {
  if (input.signal?.aborted) {
    return { ready: Promise.reject(abortError(input.signal)), close: async () => {} };
  }

  let state: ConnectState = { kind: "connecting" };
  let session: SessionState = { kind: "none" };
  let stopError: Error | undefined;
  const initController = new AbortController();

  const terminateOpenSession = async (): Promise<void> => {
    if (session.kind === "none" || session.kind === "deleted") return;
    if (session.kind === "deleting") {
      await session.promise;
      return;
    }
    const { id, protocolVersion } = session;
    const deleteController = new AbortController();
    const deleteTimer = setTimeout(() => deleteController.abort(), GITHUB_CLOSE_MS);
    deleteTimer.unref?.();
    const promise = (async () => {
      try {
        const response = await fetch(input.url, {
          method: "DELETE",
          headers: {
            ...input.headers,
            "mcp-protocol-version": protocolVersion,
            "mcp-session-id": id,
          },
          signal: deleteController.signal,
          redirect: "error",
        });
        await response.body?.cancel().catch(() => {});
      } catch {
        // Best-effort remote session cleanup, matching HttpMCPTransport.close().
      } finally {
        clearTimeout(deleteTimer);
        session = { kind: "deleted" };
      }
    })();
    session = { kind: "deleting", promise };
    await promise;
  };

  const closeClient = async (client: MCPClient) => {
    try {
      await client.close();
    } finally {
      await terminateOpenSession();
    }
  };

  const onAbort = () => {
    if (state.kind !== "connecting") return;
    stopError = abortError(input.signal!);
    void close();
  };

  const setupTimer = setTimeout(() => {
    if (state.kind !== "connecting") return;
    stopError = new Error(`GitHub MCP connection timed out after ${input.setupMs}ms`);
    void close();
  }, input.setupMs);

  const clearHandshakeGuards = () => {
    clearTimeout(setupTimer);
    input.signal?.removeEventListener("abort", onAbort);
  };

  const close = (): Promise<void> => {
    if (state.kind === "closed") return state.cleanup.then(() => terminateOpenSession());
    const current = state;
    clearHandshakeGuards();
    if (current.kind === "ready") {
      const cleanup = closeClient(current.client);
      state = { kind: "closed", cleanup };
      return cleanup;
    }
    const error = stopError ?? new Error("GitHub MCP connection was closed.");
    stopError = error;
    state = { kind: "closed", cleanup: Promise.resolve() };
    initController.abort(error);
    const cleanup = terminateOpenSession();
    state = { kind: "closed", cleanup };
    return cleanup;
  };

  input.signal?.addEventListener("abort", onAbort, { once: true });

  const mcpFetch: typeof fetch = async (requestUrl, requestInit) => {
    const method = (requestInit?.method ?? "GET").toUpperCase();
    if (method === "DELETE") {
      if (session.kind === "deleting") {
        await session.promise;
        return new Response(null, { status: 200 });
      }
      if (session.kind === "deleted") return new Response(null, { status: 200 });
      const responsePromise = fetch(requestUrl, requestInit);
      const done = responsePromise
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          session = { kind: "deleted" };
        });
      session = { kind: "deleting", promise: done };
      return responsePromise;
    }
    if (method === "POST") {
      const protocol = headerValue(requestInit?.headers, "mcp-protocol-version");
      if (protocol && session.kind === "open") {
        session = { ...session, protocolVersion: protocol };
      }
      if (rpcMethod(requestInit?.body) === "initialize") {
        initController.signal.throwIfAborted();
        const requestProtocol = protocol ?? MCP_LEGACY_PROTOCOL_VERSION;
        const initFetchController = new AbortController();
        const initFetchTimer = setTimeout(() => initFetchController.abort(), Math.max(input.setupMs, GITHUB_CLOSE_MS));
        initFetchTimer.unref?.();
        // Let an already-sent initialize finish so we still receive mcp-session-id and can send DELETE.
        const tracked = fetch(requestUrl, { ...requestInit, signal: initFetchController.signal }).then(
          async (response) => {
            const id = response.headers.get("mcp-session-id");
            if (id && session.kind === "none") {
              session = {
                kind: "open",
                id,
                protocolVersion: response.headers.get("mcp-protocol-version") ?? requestProtocol,
              };
            }
            if (initController.signal.aborted) {
              try {
                const negotiated = await readNegotiatedProtocol(response);
                if (negotiated && session.kind === "open") {
                  session = { ...session, protocolVersion: negotiated };
                }
              } finally {
                clearTimeout(initFetchTimer);
              }
              await terminateOpenSession();
              throw abortError(initController.signal);
            }
            clearTimeout(initFetchTimer);
            return response;
          },
          (error: unknown) => {
            clearTimeout(initFetchTimer);
            throw error;
          },
        );
        return raceAbort(tracked, initController.signal, (response) => {
          void response.body?.cancel().catch(() => {});
          void terminateOpenSession();
        });
      }
    }
    return fetch(requestUrl, requestInit);
  };

  const ready = createMCPClient({
    transport: {
      type: "http",
      url: input.url,
      headers: input.headers,
      redirect: "error",
      fetch: mcpFetch,
      onSessionIdChange: (id) => {
        if (!id) return;
        if (session.kind === "none") {
          session = { kind: "open", id, protocolVersion: MCP_LEGACY_PROTOCOL_VERSION };
        } else if (session.kind === "open") {
          session = { ...session, id };
        }
      },
    },
    initializationOptions: { signal: initController.signal },
  }).then(
    async (client) => {
      clearHandshakeGuards();
      if (state.kind === "closed") {
        await closeClient(client);
        throw stopError ?? new Error("GitHub MCP connection was closed.");
      }
      state = { kind: "ready", client };
      return client;
    },
    async (error: unknown) => {
      clearHandshakeGuards();
      const failure = stopError ?? error;
      await close();
      throw failure;
    },
  );

  return { ready, close };
}

// A warm turn returns the cached tools at once and starts the client, with the full setup time, at its first GitHub tool call.
// A turn that calls no GitHub tool opens no connection, so its close returns at once.
function warmTools(
  cached: CachedList,
  open: () => McpConnection,
  redact: Redactor,
  signal: AbortSignal | undefined,
): McpToolSet {
  let state: WarmState = { kind: "idle" };
  const start = () => {
    if (state.kind === "closed") throw new Error("GitHub tool unavailable");
    if (state.kind === "idle") {
      const connection = open();
      const tools = connection.ready.then(
        (client) => client.toolsFromDefinitions(cached.definitions) as Record<string, Tool>,
      );
      tools.catch((error: unknown) => {
        if (!signal?.aborted && state.kind !== "closed") {
          redact.logError("github tools unavailable", githubFailureText(error, redact));
        }
      });
      state = { kind: "started", connection, tools };
    }
    return state.tools;
  };
  const raw: Record<string, Tool> = {};
  for (const [name, shape] of Object.entries(cached.shapes)) {
    raw[name] = {
      ...shape,
      execute: async (args: unknown, options: Parameters<NonNullable<Tool["execute"]>>[1]) => {
        const execute = (await start())[name]?.execute;
        if (!execute) throw new Error("GitHub tool unavailable");
        return execute(args, options);
      },
    } as Tool;
  }
  const close = () => {
    if (state.kind === "closed") return state.cleanup;
    const current = state;
    const cleanup = current.kind === "started" ? current.connection.close() : Promise.resolve();
    state = { kind: "closed", cleanup };
    return cleanup;
  };
  return { tools: prefixedTools(raw, redact), close };
}

async function listedTools(client: MCPClient, signal: AbortSignal | undefined, timeoutMs: () => number): Promise<ListPage> {
  const options = () => ({ signal, timeout: timeoutMs() });
  let page = await client.listTools({ options: options() });
  const tools = [...page.tools];
  while (page.nextCursor) {
    page = await client.listTools({ params: { cursor: page.nextCursor }, options: options() });
    tools.push(...page.tools);
  }
  return { ...page, tools, nextCursor: undefined };
}

export async function githubTools(
  userId: UserId,
  settings: GithubSettings,
  input?: { signal?: AbortSignal; now?: number; tools?: string; setupMs?: number; redact?: Redactor },
): Promise<McpToolSet> {
  const target = githubMcpTarget(settings.githubMcpUrl);
  if (!target.ok) throw new GithubMcpUrlError();
  const mcpUrl = target.url;
  const token = settings.githubToken;
  const redact = input?.redact ?? new Redactor(settings);
  const extraTools = input?.tools ?? "";
  const setupMs = input?.setupMs ?? GITHUB_SETUP_MS;
  const started = Date.now();
  const timeoutMs = () => Math.max(1, setupMs - (Date.now() - started));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-MCP-Readonly": "true",
    "X-MCP-Toolsets": GITHUB_TOOLSETS,
    ...(extraTools ? { "X-MCP-Tools": extraTools } : {}),
  };
  const open = (timeout: number) =>
    openMcpClient({
      url: mcpUrl,
      headers,
      setupMs: timeout,
      signal: input?.signal,
    });
  const now = input?.now ?? Date.now();
  const key = createHash("sha256").update(JSON.stringify([mcpUrl, GITHUB_TOOLSETS, extraTools, token])).digest("hex");
  let listCache = listCaches.get(userId);
  if (!listCache) {
    listCache = new Map();
    listCaches.set(userId, listCache);
  }
  const cached = listCache.get(key);
  if (cached && cached.expires > now) return warmTools(cached, () => open(setupMs), redact, input?.signal);
  const connection = open(timeoutMs());
  try {
    const client = await connection.ready;
    const definitions = await listedTools(client, input?.signal, timeoutMs);
    const raw = client.toolsFromDefinitions(definitions) as Record<string, Tool>;
    const shapes = Object.fromEntries(Object.entries(raw).map(([name, tool]) => [name, { ...tool, execute: undefined } as Tool]));
    listCache.set(key, { expires: now + LIST_CACHE_MS, definitions, shapes });
    return { tools: prefixedTools(raw, redact), close: connection.close };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export async function openGithubTurn(
  userId: UserId,
  settings: GithubSettings,
  signal?: AbortSignal,
  options?: { setupMs?: number; redact?: Redactor },
): Promise<McpToolSet> {
  if (!settings.githubToken) return emptySet();
  try {
    return await githubTools(userId, settings, { signal, setupMs: options?.setupMs, redact: options?.redact });
  } catch (error) {
    if (signal?.aborted) throw error;
    const redact = options?.redact ?? new Redactor(settings);
    const failure = githubFailureText(error, redact);
    redact.logError("github tools unavailable", failure);
    return { ...emptySet(), error: failure };
  }
}

// A token submitted with the check replaces the stored one for this request, and the redactor covers both. Settings
// masks the saved URL with `connectionSecrets` too, so the URL it shows matches here.
export async function checkGithub(
  userId: UserId,
  stored: GithubSettings & Pick<UserGithubRecord, "githubTokenReadable">,
  submitted: { token?: string; mcpUrl?: string } = {},
  signal?: AbortSignal,
  connectionSecrets: readonly ConnectionSecrets[] = [],
): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  const submittedToken = submitted.token?.trim();
  if (!submittedToken && stored.githubTokenReadable === false) {
    return { ok: false, error: "Saved GitHub token is unreadable. Enter it again." };
  }
  const storedRedact = new Redactor(stored, ...connectionSecrets);
  const resolvedMcp = resolveMaskedUrl({
    submitted: submitted.mcpUrl,
    saved: stored.githubMcpUrl,
    redact: storedRedact,
    normalize: (value) => value.trim(),
    fieldLabel: "GitHub MCP URL",
    displaySaved: resolveGithubMcpUrl(stored.githubMcpUrl),
  });
  if (!resolvedMcp.ok) return { ok: false, error: resolvedMcp.error };
  const settings = {
    ...stored,
    githubToken: submittedToken || stored.githubToken,
    githubMcpUrl: resolvedMcp.url,
  };
  const redact = new Redactor(stored, settings, ...connectionSecrets);
  if (!settings.githubToken.trim()) return { ok: false, error: "Add a GitHub token." };
  try {
    const opened = await githubTools(userId, settings, { signal, tools: GITHUB_CHECK_TOOLS, redact });
    try {
      const tool = opened.tools.github_get_me;
      if (!tool?.execute) return { ok: false, error: "GitHub is unavailable." };
      // githubLogin decodes JSON inside the masked result, which can spell a credential again.
      const login = githubLogin(await tool.execute({}, { toolCallId: "github-check", messages: [], abortSignal: signal, context: undefined }));
      if (!login || redact.text(login).includes(REDACTED)) return { ok: false, error: "GitHub did not return a login." };
      return { ok: true, login };
    } finally {
      await opened.close();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof GithubMcpUrlError) return { ok: false, error: error.message };
    return { ok: false, error: githubFailureText(error, redact) };
  }
}
