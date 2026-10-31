import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ReasoningEffort } from "./settings";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

export type ListedModel = {
  id: string;
  reasoning: boolean | null;
};

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

function sessionFetch(baseUrl: string, chatId: string, baseFetch: typeof fetch): typeof fetch {
  const session = openCodeSessionHeader(baseUrl, chatId)?.["x-opencode-session"];
  if (!session) return baseFetch;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-opencode-session", session);
    return baseFetch(input, { ...init, headers });
  };
}

export function orbitModel(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  chatId: string;
  fetch?: typeof fetch;
}) {
  const baseURL = normalizeBaseUrl(options.baseUrl);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const provider = createOpenAICompatible({
    name: "orbit",
    baseURL,
    apiKey: options.apiKey,
    headers: openCodeSessionHeader(baseURL, options.chatId),
    fetch: sessionFetch(baseURL, options.chatId, fetchWithReasoningFallback(baseFetch)),
  });
  return provider(options.model);
}

export async function outboundSessionHeader(baseUrl: string, chatId: string): Promise<string | null> {
  let seen: string | null = null;
  const model = orbitModel({
    baseUrl,
    apiKey: "test",
    model: "deepseek-v4.1-flash",
    chatId,
    fetch: async (_input, init) => {
      seen = new Headers(init?.headers).get("x-opencode-session");
      return new Response(
        JSON.stringify({
          id: "test",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const { generateText } = await import("ai");
  await generateText({ model, prompt: "ping" });
  return seen;
}

export function reasoningOptions(effort: ReasoningEffort) {
  return {
    reasoning: effort,
    providerOptions: {
      orbit: { reasoningEffort: effort },
    },
  } as const;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function reasoningFlag(metadata: unknown): boolean | null {
  const record = asRecord(metadata);
  if (!record) return null;
  const capabilities = asRecord(record.capabilities);
  const reasoning = capabilities && "reasoning" in capabilities ? capabilities.reasoning : "reasoning" in record ? record.reasoning : undefined;
  if (typeof reasoning === "boolean") return reasoning;
  const reasoningRecord = asRecord(reasoning);
  if (reasoningRecord && typeof reasoningRecord.supported === "boolean") return reasoningRecord.supported;
  return null;
}

export function reasoningAllowed(metadata: unknown): boolean {
  return reasoningFlag(metadata) !== false;
}

function listedModel(item: unknown): ListedModel | null {
  if (typeof item === "string" && item.length > 0) return { id: item, reasoning: null };
  const record = asRecord(item);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
  if (!id) return null;
  return { id, reasoning: reasoningFlag(record) };
}

function modelsFromPayload(payload: unknown): ListedModel[] {
  const record = asRecord(payload);
  const raw = Array.isArray(payload) ? payload : Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
  const models = new Map<string, ListedModel>();
  for (const item of raw) {
    const model = listedModel(item);
    if (model) models.set(model.id, model);
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchModels(url: string, apiKey: string, extraHeaders?: Record<string, string>): Promise<ListedModel[] | null> {
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": "orbit/0.1",
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return modelsFromPayload(await response.json());
  } catch {
    return null;
  }
}

/** Null means no endpoint answered. An empty array means the provider has no models. */
export async function listModels(baseUrl: string, apiKey: string): Promise<ListedModel[] | null> {
  const base = normalizeBaseUrl(baseUrl);
  const session = openCodeSessionHeader(base, "models");
  const primary = await fetchModels(`${base}/models`, apiKey, session);
  if (primary && primary.length > 0) return primary;
  if (base === OPENCODE_GO_BASE_URL) {
    const fallback = await fetchModels(OPENCODE_GO_MODELS_URL, apiKey, { "x-opencode-session": "models" });
    if (fallback) return fallback;
  }
  return primary;
}

export async function modelAllowsReasoning(baseUrl: string, apiKey: string, modelId: string): Promise<boolean> {
  try {
    const models = await listModels(baseUrl, apiKey);
    const match = models?.find((model) => model.id === modelId);
    if (!match || match.reasoning == null) return true;
    return match.reasoning;
  } catch {
    return true;
  }
}
