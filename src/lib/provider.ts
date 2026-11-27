import { createAnthropic } from "@ai-sdk/anthropic";
import { getModelCapabilities } from "@ai-sdk/anthropic/internal";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { anthropicFallbacks } from "./anthropic-fallback";
import { anthropicBaseUrl, normalizeBaseUrl } from "./base-url";
import type { ProviderConnection } from "./connections";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

export { normalizeBaseUrl };

export function openCodeSessionHeader(baseUrl: string, chatId: string): Record<string, string> | undefined {
  if (normalizeBaseUrl(baseUrl) !== OPENCODE_GO_BASE_URL) return undefined;
  return { "x-opencode-session": chatId };
}

/** Preserve adaptive thinking options for models the pinned SDK knows when the Models API entry is unavailable. */
export function knownAdaptiveThinking(modelId: string): boolean {
  const caps = getModelCapabilities(modelId);
  return caps.isKnownModel && caps.supportsAdaptiveThinking;
}

function withoutReasoning(body: BodyInit | null | undefined): string | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!Object.hasOwn(parsed, "reasoning_effort") && !Object.hasOwn(parsed, "reasoningEffort")) return null;
    const remaining = parsed as Record<string, unknown>;
    delete remaining.reasoning_effort;
    delete remaining.reasoningEffort;
    return JSON.stringify(remaining);
  } catch {
    return null;
  }
}

// A provider that rejects reasoning_effort gets the request again without it. onDropped reports that only when the
// retry succeeds, so the reply can say its effort was ignored. A failed retry leaves the SDK to retry with the effort.
function fetchWithReasoningFallback(baseFetch: typeof fetch, onDropped: () => void): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 400 && response.status !== 422) return response;
    const body = withoutReasoning(init?.body);
    if (body === null || !/reasoning/i.test(await response.clone().text())) return response;
    const retried = await baseFetch(input, { ...init, body });
    if (retried.ok) onDropped();
    return retried;
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
  onDropped?: () => void;
}) {
  const baseURL = normalizeBaseUrl(options.baseUrl);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const provider = createOpenAICompatible({
    name: "orbit",
    baseURL,
    apiKey: options.apiKey,
    headers: openCodeSessionHeader(baseURL, options.chatId),
    fetch: sessionFetch(baseURL, options.chatId, fetchWithReasoningFallback(baseFetch, options.onDropped ?? (() => {}))),
  });
  return provider(options.model);
}

/** The model client for one connection. Only this function and listModels receive the plain key. */
export function languageModelFor(options: {
  connection: ProviderConnection;
  apiKey: string;
  model: string;
  chatId: string;
  onDropped?: () => void;
  fetch?: typeof fetch;
}) {
  const { connection, apiKey, model, chatId } = options;
  if (connection.kind === "anthropic") {
    return wrapLanguageModel({ model: createAnthropic({ apiKey, baseURL: anthropicBaseUrl(), fetch: options.fetch })(model), middleware: anthropicFallbacks });
  }
  return orbitModel({ baseUrl: connection.baseUrl, apiKey, model, chatId, fetch: options.fetch, onDropped: options.onDropped });
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
