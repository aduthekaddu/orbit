import { readEnv } from "./env";

export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

/** Where Anthropic connections send messages and list models. The mock provider sets it. */
export function anthropicBaseUrl() {
  return normalizeBaseUrl(readEnv("ORBIT_ANTHROPIC_BASE_URL") ?? DEFAULT_ANTHROPIC_BASE_URL);
}
