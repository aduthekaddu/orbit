import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { redactValue, sanitize } from "../chat-errors";
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

export type GithubSettings = {
  token: string;
  mcpUrl: string;
};

export type McpToolSet = {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
};

type ListPage = Awaited<ReturnType<MCPClient["listTools"]>>;

const listCache = new Map<string, { expires: number; definitions: ListPage }>();

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

export function githubFailureText(error: unknown, token: string): string {
  const status = httpStatus(error);
  const message = sanitize(error instanceof Error ? error.message : "GitHub tools unavailable", token);
  if (status === 400 || /\bHTTP 400\b/i.test(message)) return "GitHub rejected the token (bad request).";
  if (status === 401 || status === 403 || /401|403|unauthorized|forbidden/i.test(message)) return "GitHub rejected the token.";
  return "GitHub is unavailable.";
}

function redactTool(tool: Tool, token: string): Tool {
  const execute = tool.execute?.bind(tool);
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (input, options) => {
      try {
        return redactValue(await execute(input, options), token);
      } catch (error) {
        if (error instanceof Error) throw new Error(sanitize(error.message, token));
        throw error;
      }
    },
  };
}

function emptySet(): McpToolSet {
  return { tools: {}, close: async () => {} };
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

export async function githubTools(settings: GithubSettings, input?: { signal?: AbortSignal; now?: number; tools?: string; setupMs?: number }): Promise<McpToolSet> {
  const target = githubMcpTarget(settings.mcpUrl);
  if (!target.ok) throw new GithubMcpUrlError();
  const mcpUrl = target.url;
  const token = settings.token;
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
  try {
    client = await createMCPClient({
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
      initializationOptions: { signal: input?.signal, timeout: timeoutMs() },
    });
    const now = input?.now ?? Date.now();
    const key = `${mcpUrl}\n${GITHUB_TOOLSETS}\n${extraTools}\n${token}`;
    const cached = listCache.get(key);
    const definitions = cached && cached.expires > now ? cached.definitions : await listedTools(client, input?.signal, timeoutMs);
    if (!cached || cached.expires <= now) listCache.set(key, { expires: now + LIST_CACHE_MS, definitions });
    const raw = client.toolsFromDefinitions(definitions);
    const tools: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(raw)) {
      tools[name.startsWith(PREFIX) ? name : `${PREFIX}${name}`] = redactTool(tool as Tool, token);
    }
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function openGithubTurn(settings: { githubToken: string; githubMcpUrl: string }, signal?: AbortSignal, options?: { setupMs?: number }): Promise<McpToolSet> {
  if (!settings.githubToken) return emptySet();
  try {
    return await githubTools({ token: settings.githubToken, mcpUrl: settings.githubMcpUrl }, { signal, setupMs: options?.setupMs });
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error("github tools unavailable", githubFailureText(error, settings.githubToken));
    return emptySet();
  }
}

export async function checkGithub(settings: GithubSettings, signal?: AbortSignal): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  if (!settings.token.trim()) return { ok: false, error: "Add a GitHub token." };
  try {
    const opened = await githubTools({ token: settings.token, mcpUrl: settings.mcpUrl }, { signal, tools: GITHUB_CHECK_TOOLS });
    try {
      const tool = opened.tools.github_get_me;
      if (!tool?.execute) return { ok: false, error: "GitHub is unavailable." };
      const result = redactValue(await tool.execute({}, { toolCallId: "github-check", messages: [], abortSignal: signal, context: undefined }), settings.token);
      const login = githubLogin(result);
      if (!login || login.includes(settings.token) || login.includes("[redacted]")) return { ok: false, error: "GitHub did not return a login." };
      return { ok: true, login };
    } finally {
      await opened.close();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof GithubMcpUrlError) return { ok: false, error: error.message };
    return { ok: false, error: githubFailureText(error, settings.token) };
  }
}
