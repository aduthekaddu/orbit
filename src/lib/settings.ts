import { eq } from "drizzle-orm";
import { normalizeBaseUrl } from "./base-url";
import { Redactor, redactUrl } from "./chat-errors";
import { db } from "./db";
import { sandboxEnabled } from "./sandbox/enabled";
import { settings } from "./db/schema";
import { resolveGithubMcpUrl } from "./tools/github";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SettingsRecord = {
  baseUrl: string;
  apiKey: string;
  searxngUrl: string;
  tavilyApiKey: string;
  githubToken: string;
  githubMcpUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type PublicSettings = {
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  keySet: boolean;
  searxngUrl: string;
  tavilyKeySet: boolean;
  githubTokenSet: boolean;
  githubMcpUrl: string;
  sandbox: boolean;
};

function asEffort(value: string): ReasoningEffort {
  if (value === "low" || value === "high" || value === "medium") return value;
  return "medium";
}

export function getSettings(): SettingsRecord | null {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) return null;
  return {
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    searxngUrl: row.searxngUrl,
    tavilyApiKey: row.tavilyApiKey,
    githubToken: row.githubToken,
    githubMcpUrl: row.githubMcpUrl,
    model: row.model,
    reasoningEffort: asEffort(row.reasoningEffort),
  };
}

export function toPublicSettings(row: SettingsRecord | null): PublicSettings {
  const redact = new Redactor(row);
  return {
    baseUrl: row ? redactUrl(row.baseUrl, redact) : "",
    model: row?.model ?? "",
    reasoningEffort: row?.reasoningEffort ?? "medium",
    keySet: Boolean(row?.apiKey),
    searxngUrl: row ? redactUrl(row.searxngUrl, redact) : "",
    tavilyKeySet: Boolean(row?.tavilyApiKey),
    githubTokenSet: Boolean(row?.githubToken),
    githubMcpUrl: redactUrl(resolveGithubMcpUrl(row?.githubMcpUrl), redact),
    sandbox: sandboxEnabled(),
  };
}

export function matchesSavedBaseUrl(submitted: string, current: SettingsRecord): boolean {
  const normalized = normalizeBaseUrl(submitted);
  if (normalized === normalizeBaseUrl(current.baseUrl)) return true;
  if (!current.baseUrl) return false;
  const masked = redactUrl(current.baseUrl, new Redactor(current));
  return normalized === normalizeBaseUrl(masked);
}

function resolveUpdatedUrl(
  submitted: string | undefined,
  saved: string,
  redact: Redactor,
  normalize: (value: string) => string,
  displaySaved = saved,
): string {
  if (submitted === undefined) return saved;
  const normalized = normalize(submitted);
  if (saved && normalized === normalize(redactUrl(displaySaved, redact))) return saved;
  return normalized;
}

export function saveSettings(input: {
  baseUrl: string;
  apiKey?: string;
  searxngUrl?: string;
  tavilyApiKey?: string | null;
  githubToken?: string | null;
  githubMcpUrl?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}) {
  const current = getSettings();
  const currentRedact = new Redactor(current);
  const sameSavedBase = current !== null && matchesSavedBaseUrl(input.baseUrl, current);
  const baseUrl = current
    ? resolveUpdatedUrl(input.baseUrl, current.baseUrl, currentRedact, normalizeBaseUrl)
    : normalizeBaseUrl(input.baseUrl);
  const requestedKey = input.apiKey?.trim() ?? "";
  const apiKey = requestedKey || (sameSavedBase ? current.apiKey : "");
  const trimSearx = (value: string) => value.trim().replace(/\/+$/, "");
  const searxngUrl = current
    ? resolveUpdatedUrl(input.searxngUrl, current.searxngUrl, currentRedact, trimSearx)
    : trimSearx(input.searxngUrl ?? "");
  const githubMcpUrl = current
    ? resolveUpdatedUrl(
        input.githubMcpUrl,
        current.githubMcpUrl,
        currentRedact,
        (value) => value.trim(),
        resolveGithubMcpUrl(current.githubMcpUrl),
      )
    : (input.githubMcpUrl?.trim() ?? "");
  const values = {
    id: 1,
    baseUrl,
    apiKey,
    searxngUrl,
    tavilyApiKey: input.tavilyApiKey === null ? "" : input.tavilyApiKey?.trim() || current?.tavilyApiKey || "",
    githubToken: input.githubToken === null ? "" : input.githubToken?.trim() || current?.githubToken || "",
    githubMcpUrl,
    model: input.model.trim(),
    reasoningEffort: input.reasoningEffort,
    updatedAt: new Date(),
  };
  db.insert(settings).values(values).onConflictDoUpdate({ target: settings.id, set: values }).run();
  return toPublicSettings(values);
}
