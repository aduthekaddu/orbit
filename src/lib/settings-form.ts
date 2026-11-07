import type { ModelOption } from "./model-picker";
import type { ReasoningEffort } from "./settings";

export type Connection =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; models: ModelOption[] }
  | { status: "failed" };

export function connectionFromResponse(
  response: { ok: boolean; status: number },
  body: { models?: ModelOption[] },
  hasKey: boolean,
): Connection {
  if (response.status === 400) return { status: "idle" };
  if (!response.ok) return { status: "failed" };
  const models = body.models ?? [];
  if (models.length === 0 && !hasKey) return { status: "idle" };
  return { status: "connected", models };
}

export type SettingsSnapshot = {
  baseUrl: string;
  apiKey: string;
  searxngUrl: string;
  tavilyApiKey: string | null;
  githubToken: string;
  githubMcpUrl: string;
  model: string;
  effort: ReasoningEffort;
};

export type AppliedSave = {
  clearKey: boolean;
  clearTavilyKey: boolean;
  clearGithubToken: boolean;
  applyKeySet: boolean;
  saved: boolean;
};

export function appliedSave(submitted: SettingsSnapshot, current: SettingsSnapshot): AppliedSave {
  const sameBaseUrl = current.baseUrl === submitted.baseUrl;
  const sameKey = current.apiKey === submitted.apiKey;
  const sameTavilyKey = current.tavilyApiKey === submitted.tavilyApiKey;
  const sameGithubToken = current.githubToken === submitted.githubToken;
  return {
    clearKey: sameKey,
    clearTavilyKey: sameTavilyKey,
    clearGithubToken: sameGithubToken,
    applyKeySet: sameBaseUrl,
    saved: sameBaseUrl && sameKey && sameTavilyKey && sameGithubToken && current.githubMcpUrl === submitted.githubMcpUrl && current.searxngUrl === submitted.searxngUrl && current.model === submitted.model && current.effort === submitted.effort,
  };
}
