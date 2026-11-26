import { tavily } from "@tavily/core";
import { tool } from "ai";
import { z } from "zod";
import { Redactor } from "../chat-errors";
import { withTavilySignal } from "./tavily-signal";
import { STOP_MARKERS } from "./run-status";

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

class SearchHttpError extends Error {
  constructor(readonly status: number) {
    super(`SearXNG returned HTTP ${status}`);
  }
}

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

function maskResultUrl(href: string, redact: Redactor | undefined): string | null {
  let clean = href;
  if (redact) {
    try {
      const parsed = new URL(clean);
      if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
        clean = parsed.href;
      }
    } catch {
      return null;
    }
    clean = redact.text(clean);
  }
  try {
    const checked = new URL(clean);
    if (checked.protocol !== "http:" && checked.protocol !== "https:") return null;
    return clean;
  } catch {
    return null;
  }
}

export function parseSearchResults(response: unknown, engine: SearchResult["engine"], redact?: Redactor): SearchResult[] {
  const parsed = responseSchema.parse(response);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of parsed.results) {
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const href = maskResultUrl(url.href, redact);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const title = plainText(item.title);
    const content = plainText(item.content ?? "");
    results.push({
      title: redact ? redact.text(title) : title,
      url: href,
      snippet: (redact ? redact.text(content) : content).slice(0, 300),
      engine,
    });
    if (results.length === 8) break;
  }
  return results;
}

function searchSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function searchSearxng(url: string, query: string, signal?: AbortSignal, redact?: Redactor): Promise<SearchResult[]> {
  const endpoint = new URL(url);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/search`;
  endpoint.hash = "";
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, { signal: searchSignal(signal) });
  if (!response.ok) throw new SearchHttpError(response.status);
  return parseSearchResults(await response.json(), "searxng", redact);
}

export async function searchTavily(key: string, query: string, signal?: AbortSignal, redact?: Redactor): Promise<SearchResult[]> {
  const abort = searchSignal(signal);
  abort.throwIfAborted();
  const client = tavily({ apiKey: key });
  const response = await withTavilySignal(abort, () => client.search(query, { maxResults: 8, timeout: 8, includeRawContent: false }));
  return parseSearchResults(response, "tavily", redact);
}

export async function searchWeb(
  settings: SearchSettings,
  query: string,
  signal?: AbortSignal,
  backends: SearchBackends = { searxng: searchSearxng, tavily: searchTavily },
  redact?: Redactor,
): Promise<SearchOutput> {
  const mask = redact ?? new Redactor({ apiKey: "", tavilyApiKey: settings.tavilyApiKey, githubToken: "", searxngUrl: settings.searxngUrl });
  const safeQuery = mask.text(query);
  let timedOut = false;
  const attempts: Array<{ backend: SearchResult["engine"]; run: () => Promise<SearchResult[]> }> = [];
  if (settings.searxngUrl) {
    attempts.push({
      backend: "searxng",
      run: () => backends.searxng(settings.searxngUrl, query, signal, mask),
    });
  }
  if (settings.tavilyApiKey) {
    attempts.push({
      backend: "tavily",
      run: () => backends.tavily(settings.tavilyApiKey, query, signal, mask),
    });
  }
  for (const attempt of attempts) {
    if (signal?.aborted) return { ok: false, query: safeQuery, error: STOP_MARKERS.searchStopped };
    try {
      const results = await attempt.run();
      if (signal?.aborted) return { ok: false, query: safeQuery, error: STOP_MARKERS.searchStopped };
      if (results.length) return { ok: true, query: safeQuery, results };
    } catch (error) {
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") continue;
      const category = error instanceof SearchHttpError ? "HttpError"
        : error instanceof Error && ["TimeoutError", "TypeError", "SyntaxError", "ZodError"].includes(error.name) ? error.name : "Error";
      console.warn("web search backend failed", {
        backend: attempt.backend,
        error: category,
        ...(error instanceof SearchHttpError ? { status: error.status } : {}),
      });
      timedOut ||= error instanceof Error && error.name === "TimeoutError";
    }
  }
  if (signal?.aborted) return { ok: false, query: safeQuery, error: STOP_MARKERS.searchStopped };
  return { ok: false, query: safeQuery, error: timedOut ? "Search timed out" : "Search is unavailable" };
}

export function createSearchTool(settings: SearchSettings, redact?: Redactor) {
  return tool({
    description: "Search the web for titles, URLs, and short snippets. Use the result URLs when citing sources.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(500) }),
    execute: ({ query }, { abortSignal }) => searchWeb(settings, query, abortSignal, undefined, redact),
  });
}
