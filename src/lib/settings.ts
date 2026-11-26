import { eq } from "drizzle-orm";
import { normalizeBaseUrl } from "./base-url";
import { Redactor, redactUrl, resolveMaskedUrl } from "./chat-errors";
import { getDb } from "./db";
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
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
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

const trimSearx = (value: string) => value.trim().replace(/\/+$/, "");

export type ResolvedSettingsUrls =
  | { ok: true; baseUrl: string; searxngUrl: string; githubMcpUrl: string }
  | { ok: false; error: string };

export function resolveSettingsUrls(
  input: { baseUrl: string; searxngUrl?: string; githubMcpUrl?: string },
  current: SettingsRecord | null,
): ResolvedSettingsUrls {
  const currentRedact = new Redactor(current);
  const base = resolveMaskedUrl({
    submitted: input.baseUrl,
    saved: current?.baseUrl ?? "",
    redact: currentRedact,
    normalize: normalizeBaseUrl,
    fieldLabel: "Base URL",
  });
  if (!base.ok) return base;
  const searx = resolveMaskedUrl({
    submitted: input.searxngUrl,
    saved: current?.searxngUrl ?? "",
    redact: currentRedact,
    normalize: trimSearx,
    fieldLabel: "SearXNG URL",
  });
  if (!searx.ok) return searx;
  const mcp = resolveMaskedUrl({
    submitted: input.githubMcpUrl,
    saved: current?.githubMcpUrl ?? "",
    redact: currentRedact,
    normalize: (value) => value.trim(),
    fieldLabel: "GitHub MCP URL",
    displaySaved: resolveGithubMcpUrl(current?.githubMcpUrl),
  });
  if (!mcp.ok) return mcp;
  return { ok: true, baseUrl: base.url, searxngUrl: searx.url, githubMcpUrl: mcp.url };
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
  const resolved = resolveSettingsUrls(input, current);
  if (!resolved.ok) throw new Error(resolved.error);
  const sameSavedBase = current !== null && normalizeBaseUrl(resolved.baseUrl) === normalizeBaseUrl(current.baseUrl);
  const requestedKey = input.apiKey?.trim() ?? "";
  const apiKey = requestedKey || (sameSavedBase ? current.apiKey : "");
  const values = {
    id: 1,
    baseUrl: resolved.baseUrl,
    apiKey,
    searxngUrl: resolved.searxngUrl,
    tavilyApiKey: input.tavilyApiKey === null ? "" : input.tavilyApiKey?.trim() || current?.tavilyApiKey || "",
    githubToken: input.githubToken === null ? "" : input.githubToken?.trim() || current?.githubToken || "",
    githubMcpUrl: resolved.githubMcpUrl,
    model: input.model.trim(),
    reasoningEffort: input.reasoningEffort,
    updatedAt: new Date(),
  };
  getDb().insert(settings).values(values).onConflictDoUpdate({ target: settings.id, set: values }).run();
  return toPublicSettings(values);
}
