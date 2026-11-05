import { tavily } from "@tavily/core";
import { tool } from "ai";
import { z } from "zod";
import { withTavilySignal } from "./tavily-signal";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  engine: "searxng" | "tavily";
};

export type SearchOutput =
  | { ok: true; query: string; results: SearchResult[] }
  | { ok: false; query: string; error: string };

export type SearchSettings = { searxngUrl: string; tavilyApiKey: string };
export type SearchBackends = {
  searxng: typeof searchSearxng;
  tavily: typeof searchTavily;
};

const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string().nullish(),
  })),
});

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function plainText(value: string) {
  return value
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    })
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSearchResults(response: unknown, engine: SearchResult["engine"]): SearchResult[] {
  const parsed = responseSchema.parse(response);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of parsed.results) {
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ title: plainText(item.title), url: href, snippet: plainText(item.content ?? "").slice(0, 300), engine });
    if (results.length === 8) break;
  }
  return results;
}

function searchSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function searchSearxng(url: string, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const endpoint = new URL(url);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/search`;
  endpoint.hash = "";
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, { signal: searchSignal(signal) });
  if (!response.ok) throw new Error("SearXNG is unavailable");
  return parseSearchResults(await response.json(), "searxng");
}

export async function searchTavily(key: string, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const abort = searchSignal(signal);
  abort.throwIfAborted();
  const client = tavily({ apiKey: key });
  const response = await withTavilySignal(abort, () => client.search(query, { maxResults: 8, timeout: 8, includeRawContent: false }));
  return parseSearchResults(response, "tavily");
}

export async function searchWeb(
  settings: SearchSettings,
  query: string,
  signal?: AbortSignal,
  backends: SearchBackends = { searxng: searchSearxng, tavily: searchTavily },
): Promise<SearchOutput> {
  let timedOut = false;
  const attempts: Array<() => Promise<SearchResult[]>> = [];
  if (settings.searxngUrl) attempts.push(() => backends.searxng(settings.searxngUrl, query, signal));
  if (settings.tavilyApiKey) attempts.push(() => backends.tavily(settings.tavilyApiKey, query, signal));
  for (const attempt of attempts) {
    if (signal?.aborted) return { ok: false, query, error: "Search was stopped" };
    try {
      const results = await attempt();
      if (signal?.aborted) return { ok: false, query, error: "Search was stopped" };
      if (results.length) return { ok: true, query, results };
    } catch (error) {
      timedOut ||= error instanceof Error && error.name === "TimeoutError";
    }
  }
  if (signal?.aborted) return { ok: false, query, error: "Search was stopped" };
  return { ok: false, query, error: timedOut ? "Search timed out" : "Search is unavailable" };
}

export function createSearchTool(settings: SearchSettings) {
  return tool({
    description: "Search the web for titles, URLs, and short snippets. Use the result URLs when citing sources.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(500) }),
    execute: ({ query }, { abortSignal }) => searchWeb(settings, query, abortSignal),
  });
}
