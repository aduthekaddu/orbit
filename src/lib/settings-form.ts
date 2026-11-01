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
  model: string;
  effort: ReasoningEffort;
};

export type AppliedSave = {
  clearKey: boolean;
  applyKeySet: boolean;
  saved: boolean;
};

export function appliedSave(submitted: SettingsSnapshot, current: SettingsSnapshot): AppliedSave {
  const sameBaseUrl = current.baseUrl === submitted.baseUrl;
  const sameKey = current.apiKey === submitted.apiKey;
  return {
    clearKey: sameKey,
    applyKeySet: sameBaseUrl,
    saved: sameBaseUrl && sameKey && current.model === submitted.model && current.effort === submitted.effort,
  };
}
