import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ReasoningEffort } from "./settings";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function openCodeSessionHeader(baseUrl: string, chatId: string): Record<string, string> | undefined {
  if (normalizeBaseUrl(baseUrl) !== OPENCODE_GO_BASE_URL) return undefined;
  return { "x-opencode-session": chatId };
}

function withoutReasoning(body: string) {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.reasoning_effort;
  delete parsed.reasoningEffort;
  return JSON.stringify(parsed);
}

function fetchWithReasoningFallback(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.ok) return response;
    const body = typeof init?.body === "string" ? init.body : null;
    if (!body || !body.includes("reasoning_effort") && !body.includes("reasoningEffort")) return response;
    const copy = response.clone();
    const text = await copy.text();
    if (response.status < 400 || !/reasoning/i.test(text)) return response;
    return baseFetch(input, { ...init, body: withoutReasoning(body) });
  };
}

export function orbitModel(options: { baseUrl: string; apiKey: string; model: string; chatId: string }) {
  const baseURL = normalizeBaseUrl(options.baseUrl);
  const provider = createOpenAICompatible({
    name: "orbit",
    baseURL,
    apiKey: options.apiKey,
    headers: openCodeSessionHeader(baseURL, options.chatId),
    fetch: fetchWithReasoningFallback(globalThis.fetch),
  });
  return provider(options.model);
}

export function reasoningOptions(effort: ReasoningEffort) {
  return {
    reasoning: effort,
    providerOptions: {
      orbit: { reasoningEffort: effort },
    },
  } as const;
}

export async function listModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Model list failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    data?: unknown;
    models?: unknown;
  };
  const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const ids = raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as { id?: unknown; name?: unknown };
        if (typeof record.id === "string") return record.id;
        if (typeof record.name === "string") return record.name;
      }
      return "";
    })
    .filter((id) => id.length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
