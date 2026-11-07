import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { sanitize } from "../chat-errors";
import { githubLogin } from "./github-links";

export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_TOOLSETS = "repos,issues,pull_requests";
export const GITHUB_CHECK_TOOLS = "get_me";
const LIST_CACHE_MS = 5 * 60 * 1000;
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

export function githubFailureText(error: unknown, token: string): string {
  const message = sanitize(error instanceof Error ? error.message : "GitHub tools unavailable", token);
  if (/401|403|unauthorized|forbidden/i.test(message)) return "GitHub rejected the token.";
  return "GitHub is unavailable.";
}

function emptySet(): McpToolSet {
  return { tools: {}, close: async () => {} };
}

async function listedTools(client: MCPClient, signal?: AbortSignal): Promise<ListPage> {
  const options = signal ? { signal } : undefined;
  let page = await client.listTools(options ? { options } : undefined);
  const tools = [...page.tools];
  while (page.nextCursor) {
    page = await client.listTools({ params: { cursor: page.nextCursor }, options });
    tools.push(...page.tools);
  }
  return { ...page, tools, nextCursor: undefined };
}

export async function githubTools(settings: GithubSettings, input?: { signal?: AbortSignal; now?: number; tools?: string }): Promise<McpToolSet> {
  const mcpUrl = resolveGithubMcpUrl(settings.mcpUrl);
  const token = settings.token;
  const extraTools = input?.tools ?? "";
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
      initializationOptions: input?.signal ? { signal: input.signal } : undefined,
    });
    const now = input?.now ?? Date.now();
    const key = `${mcpUrl}\n${GITHUB_TOOLSETS}\n${extraTools}\n${token}`;
    const cached = listCache.get(key);
    const definitions = cached && cached.expires > now ? cached.definitions : await listedTools(client, input?.signal);
    if (!cached || cached.expires <= now) listCache.set(key, { expires: now + LIST_CACHE_MS, definitions });
    const raw = client.toolsFromDefinitions(definitions);
    const tools: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(raw)) {
      tools[name.startsWith(PREFIX) ? name : `${PREFIX}${name}`] = tool as Tool;
    }
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function openGithubTurn(settings: { githubToken: string; githubMcpUrl: string }, signal?: AbortSignal): Promise<McpToolSet> {
  if (!settings.githubToken) return emptySet();
  try {
    return await githubTools({ token: settings.githubToken, mcpUrl: settings.githubMcpUrl }, { signal });
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
      const result = await tool.execute({}, { toolCallId: "github-check", messages: [], abortSignal: signal, context: undefined });
      const login = githubLogin(result);
      if (!login) return { ok: false, error: "GitHub did not return a login." };
      return { ok: true, login };
    } finally {
      await opened.close();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, error: githubFailureText(error, settings.token) };
  }
}
