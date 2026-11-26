import { z } from "zod";
import { anthropicBaseUrl, normalizeBaseUrl } from "./base-url";
import { Redactor } from "./chat-errors";
import type { ProviderConnection } from "./connections";
import { EFFORTS, type Effort } from "./effort";
import { OPENCODE_GO_BASE_URL, OPENCODE_GO_MODELS_URL, openCodeSessionHeader } from "./provider";

export type ModelCaps = {
  images: boolean | null; // null means the provider did not say
  tools: boolean | null;
  reasoning: boolean | null;
  contextTokens: number | null;
  efforts: Effort[] | null; // the levels the model takes, or null when unknown
};
export type ListedModel = { id: string; label: string; caps: ModelCaps };

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL_CAPS_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ANTHROPIC_PAGES = 20;

const UNKNOWN_CAPS: ModelCaps = { images: null, tools: null, reasoning: null, contextTokens: null, efforts: null };

const supported = z.object({ supported: z.boolean() }).partial().optional().catch(undefined);
const tokens = z.number().int().positive().optional().catch(undefined);

const anthropicPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().optional().catch(undefined),
      max_input_tokens: tokens,
      capabilities: z
        .object({
          image_input: supported,
          thinking: z
            .object({ supported: z.boolean().optional(), types: z.object({ disabled: supported }).partial().optional() })
            .partial()
            .optional()
            .catch(undefined),
          effort: z.record(z.string(), z.unknown()).optional().catch(undefined),
        })
        .partial()
        .optional()
        .catch(undefined),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

type AnthropicEntry = z.infer<typeof anthropicPage>["data"][number];

// The Models API names each effort level, and whether thinking can be turned off, which is the None level. None is
// offered only when the entry says so. Without effort capabilities the levels are unknown, so the route sends the
// chosen effort and reports what the provider did with it.
function anthropicEfforts(capabilities: AnthropicEntry["capabilities"]): Effort[] | null {
  const effort = capabilities?.effort;
  if (!effort) return null;
  const levels = EFFORTS.filter((level) => level !== "none" && supported.parse(effort[level])?.supported === true);
  return capabilities?.thinking?.types?.disabled?.supported === true ? ["none", ...levels] : levels;
}

function anthropicModel(entry: AnthropicEntry): ListedModel {
  const capabilities = entry.capabilities;
  return {
    id: entry.id,
    label: entry.display_name ?? entry.id,
    caps: {
      images: capabilities?.image_input?.supported ?? null,
      // Every model the Models API lists takes tools.
      tools: true,
      reasoning: capabilities?.thinking?.supported ?? null,
      contextTokens: entry.max_input_tokens ?? null,
      efforts: anthropicEfforts(capabilities),
    },
  };
}

const openAiEntry = z.object({
  id: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  capabilities: z.object({ reasoning: z.unknown() }).partial().optional().catch(undefined),
  reasoning: z.unknown().optional(),
  context_length: tokens,
  context_window: tokens,
  architecture: z.object({ input_modalities: z.array(z.string()).optional().catch(undefined) }).partial().optional().catch(undefined),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
});

const openAiList = z.union([
  z.array(z.unknown()).transform((data) => ({ data })),
  z.object({ data: z.array(z.unknown()) }),
  z.object({ models: z.array(z.unknown()) }).transform(({ models }) => ({ data: models })),
]);

function reasoningFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return supported.parse(value)?.supported ?? null;
}

// Fields from OpenRouter-style lists. A list that names its parameters or input types also says what is missing, except
// for reasoning: only an explicit flag turns effort off, because a wrong false would hide the effort control.
function openAiModel(item: unknown): ListedModel | null {
  if (typeof item === "string") return item ? { id: item, label: item, caps: UNKNOWN_CAPS } : null;
  const parsed = openAiEntry.safeParse(item);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const id = entry.id || entry.name;
  if (!id) return null;
  const parameters = entry.supported_parameters;
  const modalities = entry.architecture?.input_modalities;
  const explicit = entry.capabilities && "reasoning" in entry.capabilities ? reasoningFlag(entry.capabilities.reasoning) : reasoningFlag(entry.reasoning);
  const listedReasoning = parameters?.some((name) => name === "reasoning" || name === "reasoning_effort" || name === "include_reasoning") ? true : null;
  return {
    id,
    label: entry.name || id,
    caps: {
      images: modalities ? modalities.includes("image") : null,
      tools: parameters ? parameters.includes("tools") : null,
      reasoning: explicit ?? listedReasoning,
      contextTokens: entry.context_length ?? entry.context_window ?? null,
      efforts: null,
    },
  };
}

function parseOpenAiList(payload: unknown): ListedModel[] | null {
  const list = openAiList.safeParse(payload);
  if (!list.success) return null;
  const models: ListedModel[] = [];
  for (const item of list.data.data) {
    const model = openAiModel(item);
    if (model) models.push(model);
  }
  return models;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "orbit/0.1", ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function openAiModelsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.username = "";
  url.password = "";
  return url.toString();
}

async function listOpenAiModels(baseUrl: string, apiKey: string): Promise<ListedModel[] | null> {
  const base = normalizeBaseUrl(baseUrl);
  const auth = { authorization: `Bearer ${apiKey}` };
  let primary: ListedModel[] | null = null;
  try {
    primary = parseOpenAiList(await getJson(openAiModelsUrl(base), { ...auth, ...openCodeSessionHeader(base, "models") }));
  } catch {
    primary = null;
  }
  if (primary && primary.length > 0) return primary;
  if (base === OPENCODE_GO_BASE_URL) {
    const fallback = parseOpenAiList(await getJson(OPENCODE_GO_MODELS_URL, { ...auth, "x-opencode-session": "models" }));
    if (fallback) return fallback;
  }
  return primary;
}

async function listAnthropicModels(apiKey: string): Promise<ListedModel[] | null> {
  const models: ListedModel[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
    const url = new URL(`${anthropicBaseUrl()}/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const parsed = anthropicPage.safeParse(await getJson(url.toString(), { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }));
    if (!parsed.success) return null;
    models.push(...parsed.data.data.map(anthropicModel));
    afterId = parsed.data.has_more ? (parsed.data.last_id ?? parsed.data.data.at(-1)?.id ?? null) : null;
    if (!afterId) return models;
  }
  return models;
}

type CachedCaps = { caps: ModelCaps; expiresAt: number };
const capsCache = new Map<string, CachedCaps>();
const cacheKey = (connectionId: string, modelId: string) => `${connectionId}\0${modelId}`;

function rememberCaps(connectionId: string, models: ListedModel[], now = Date.now()) {
  const prefix = cacheKey(connectionId, "");
  for (const key of capsCache.keys()) {
    if (key.startsWith(prefix)) capsCache.delete(key);
  }
  for (const model of models) capsCache.set(cacheKey(connectionId, model.id), { caps: model.caps, expiresAt: now + MODEL_CAPS_TTL_MS });
}

/** The caps the last list gave this model, for five minutes. A miss never sends a request. */
export function cachedCaps(connectionId: string, modelId: string, now = Date.now()): ModelCaps | null {
  const key = cacheKey(connectionId, modelId);
  const hit = capsCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    capsCache.delete(key);
    return null;
  }
  return hit.caps;
}

function masked(models: ListedModel[], redactors: Redactor[]): ListedModel[] {
  const mask = (text: string) => redactors.reduce((value, redact) => redact.text(value), text);
  const unique = new Map<string, ListedModel>();
  for (const model of models) {
    const id = mask(model.id);
    if (!unique.has(id)) unique.set(id, { ...model, id, label: mask(model.label) });
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Null means no endpoint answered. An empty array means the provider has no models. A provider can repeat a credential
 * in a model id, so ids and labels are masked with this key and `redact`, the request's Redactor, before they are cached.
 */
export async function listModels(connection: ProviderConnection, apiKey: string, redact: Redactor): Promise<ListedModel[] | null> {
  const models = connection.kind === "anthropic" ? await listAnthropicModels(apiKey) : await listOpenAiModels(connection.baseUrl, apiKey);
  if (!models) return null;
  const shown = masked(models, [new Redactor({ apiKey, baseUrl: connection.kind === "anthropic" ? undefined : connection.baseUrl }), redact]);
  rememberCaps(connection.id, shown);
  return shown;
}
