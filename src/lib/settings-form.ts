import { z } from "zod";
import type { ModelOption } from "./model-picker";
import type { Loaded } from "./request-json";
import type { ReasoningEffort } from "./settings";

export type Connection =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; models: ModelOption[] }
  | { status: "failed" };

export type ModelList = { models: ModelOption[]; hasKey: boolean };

// `hasKey` is the value when the request started, so typing a key before the answer does not relabel it.
export function modelListBody(hasKey: boolean): z.ZodType<ModelList> {
  return z
    .object({ models: z.array(z.object({ id: z.string(), reasoning: z.boolean().nullable() })) })
    .transform(({ models }) => ({ models, hasKey }));
}

export function connectionFrom(load: Loaded<ModelList>): Connection {
  switch (load.status) {
    case "idle":
      return { status: "idle" };
    case "pending":
      return { status: "checking" };
    case "failed":
      return load.failure.kind === "http" && load.failure.status === 400 ? { status: "idle" } : { status: "failed" };
    case "done":
      return load.data.models.length === 0 && !load.data.hasKey ? { status: "idle" } : { status: "connected", models: load.data.models };
  }
}

export type SettingsSnapshot = {
  baseUrl: string;
  apiKey: string;
  searxngUrl: string;
  tavilyApiKey: string | null;
  githubToken: string | null;
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
