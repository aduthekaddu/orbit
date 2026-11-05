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

export function parseSearchResults(_response: unknown, _engine: SearchResult["engine"]): SearchResult[] {
  return [];
}

export async function searchSearxng(_url: string, _query: string, _signal?: AbortSignal): Promise<SearchResult[]> {
  return [];
}

export async function searchTavily(_key: string, _query: string, _signal?: AbortSignal): Promise<SearchResult[]> {
  return [];
}

export async function searchWeb(
  _settings: SearchSettings,
  query: string,
  _signal?: AbortSignal,
  _backends?: SearchBackends,
): Promise<SearchOutput> {
  return { ok: false, query, error: "Search is not implemented" };
}
