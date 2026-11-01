import type { ReasoningEffort } from "./settings";

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
