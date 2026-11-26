import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { REDACTED, Redactor, redactUrl, type StoredCredentials } from "../chat-errors";
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
const PREFIX = "github_";

export type GithubSettings = StoredCredentials & { githubMcpUrl: string };

export type McpToolSet = {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
};

type ListPage = Awaited<ReturnType<MCPClient["listTools"]>>;

type CachedList = { expires: number; definitions: ListPage; shapes: Record<string, Tool> };

const listCache = new Map<string, CachedList>();

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

// A warm turn returns the cached tools at once and starts the client, with the full setup time, at its first GitHub tool call.
// A turn that calls no GitHub tool opens no connection, so its close returns at once.
function warmTools(cached: CachedList, connect: () => Promise<MCPClient>, redact: Redactor, signal: AbortSignal | undefined): McpToolSet {
  let ready: Promise<{ client: MCPClient; tools: Record<string, Tool> }> | undefined;
  let closed = false;
  const start = () => {
    if (closed) throw new Error("GitHub tool unavailable");
    if (!ready) {
      ready = connect().then((client) => ({ client, tools: client.toolsFromDefinitions(cached.definitions) as Record<string, Tool> }));
      ready.catch((error: unknown) => {
        if (!signal?.aborted) redact.logError("github tools unavailable", githubFailureText(error, redact));
      });
    }
    return ready;
  };
  const raw: Record<string, Tool> = {};
  for (const [name, shape] of Object.entries(cached.shapes)) {
    raw[name] = {
      ...shape,
      execute: async (args: unknown, options: Parameters<NonNullable<Tool["execute"]>>[1]) => {
        const execute = (await start()).tools[name]?.execute;
        if (!execute) throw new Error("GitHub tool unavailable");
        return execute(args, options);
      },
    } as Tool;
  }
  const close = async () => {
    if (closed) return;
    closed = true;
    const started = await ready?.catch(() => null);
    if (started) await started.client.close();
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
  let client: MCPClient | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (client) await client.close();
  };
  const connect = (timeout: number) =>
    createMCPClient({
      transport: {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-MCP-Readonly": "true",
          "X-MCP-Toolsets": GITHUB_TOOLSETS,
          ...(extraTools ? { "X-MCP-Tools": extraTools } : {}),
        },
        redirect: "error",
      },
      initializationOptions: { signal: input?.signal, timeout },
    });
  const now = input?.now ?? Date.now();
  const key = `${mcpUrl}\n${GITHUB_TOOLSETS}\n${extraTools}\n${token}`;
  const cached = listCache.get(key);
  if (cached && cached.expires > now) return warmTools(cached, () => connect(setupMs), redact, input?.signal);
  try {
    client = await connect(timeoutMs());
    const definitions = await listedTools(client, input?.signal, timeoutMs);
    const raw = client.toolsFromDefinitions(definitions) as Record<string, Tool>;
    const shapes = Object.fromEntries(Object.entries(raw).map(([name, tool]) => [name, { ...tool, execute: undefined } as Tool]));
    listCache.set(key, { expires: now + LIST_CACHE_MS, definitions, shapes });
    return { tools: prefixedTools(raw, redact), close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function openGithubTurn(
  settings: GithubSettings,
  signal?: AbortSignal,
  options?: { setupMs?: number; redact?: Redactor },
): Promise<McpToolSet> {
  if (!settings.githubToken) return emptySet();
  try {
    return await githubTools(settings, { signal, setupMs: options?.setupMs, redact: options?.redact });
  } catch (error) {
    if (signal?.aborted) throw error;
    const redact = options?.redact ?? new Redactor(settings);
    redact.logError("github tools unavailable", githubFailureText(error, redact));
    return emptySet();
  }
}

// A token submitted with the check replaces the stored one for this request, and the redactor covers both.
export async function checkGithub(
  stored: GithubSettings,
  submitted: { token?: string; mcpUrl?: string } = {},
  signal?: AbortSignal,
): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  const storedRedact = new Redactor(stored);
  const submittedUrl = submitted.mcpUrl?.trim();
  const maskedStoredUrl = redactUrl(resolveGithubMcpUrl(stored.githubMcpUrl), storedRedact);
  const githubMcpUrl =
    submittedUrl === undefined
      ? stored.githubMcpUrl
      : stored.githubMcpUrl && submittedUrl === maskedStoredUrl
        ? stored.githubMcpUrl
        : submittedUrl;
  const settings = {
    ...stored,
    githubToken: submitted.token?.trim() || stored.githubToken,
    githubMcpUrl,
  };
  const redact = new Redactor(stored, settings);
  if (!settings.githubToken.trim()) return { ok: false, error: "Add a GitHub token." };
  try {
    const opened = await githubTools(settings, { signal, tools: GITHUB_CHECK_TOOLS, redact });
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
