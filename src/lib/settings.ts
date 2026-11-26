import { eq } from "drizzle-orm";
import { Redactor, redactUrl, resolveMaskedUrl } from "./chat-errors";
import type { ConnectionSecrets } from "./connections";
import { getDb } from "./db";
import { sandboxEnabled } from "./sandbox/enabled";
import { settings } from "./db/schema";
import { resolveGithubMcpUrl } from "./tools/github";

export type SettingsRecord = {
  searxngUrl: string;
  tavilyApiKey: string;
  githubToken: string;
  githubMcpUrl: string;
};

export type PublicSettings = {
  searxngUrl: string;
  tavilyKeySet: boolean;
  githubTokenSet: boolean;
  githubMcpUrl: string;
  sandbox: boolean;
};

const NO_SETTINGS: SettingsRecord = { searxngUrl: "", tavilyApiKey: "", githubToken: "", githubMcpUrl: "" };

/** The settings row, or empty settings when nothing was saved yet, so a user with only a connection can chat. */
export function getSettings(): SettingsRecord {
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) return NO_SETTINGS;
  return { searxngUrl: row.searxngUrl, tavilyApiKey: row.tavilyApiKey, githubToken: row.githubToken, githubMcpUrl: row.githubMcpUrl };
}

export function toPublicSettings(row: SettingsRecord, connectionSecrets: readonly ConnectionSecrets[] = []): PublicSettings {
  const redact = new Redactor(row, ...connectionSecrets);
  return {
    searxngUrl: redactUrl(row.searxngUrl, redact),
    tavilyKeySet: Boolean(row.tavilyApiKey),
    githubTokenSet: Boolean(row.githubToken),
    githubMcpUrl: redactUrl(resolveGithubMcpUrl(row.githubMcpUrl), redact),
    sandbox: sandboxEnabled(),
  };
}

const trimSearx = (value: string) => value.trim().replace(/\/+$/, "");

export type ResolvedSettingsUrls =
  | { ok: true; searxngUrl: string; githubMcpUrl: string }
  | { ok: false; error: string };

export function resolveSettingsUrls(input: { searxngUrl?: string; githubMcpUrl?: string }, current: SettingsRecord): ResolvedSettingsUrls {
  const currentRedact = new Redactor(current);
  const searx = resolveMaskedUrl({
    submitted: input.searxngUrl,
    saved: current.searxngUrl,
    redact: currentRedact,
    normalize: trimSearx,
    fieldLabel: "SearXNG URL",
  });
  if (!searx.ok) return searx;
  const mcp = resolveMaskedUrl({
    submitted: input.githubMcpUrl,
    saved: current.githubMcpUrl,
    redact: currentRedact,
    normalize: (value) => value.trim(),
    fieldLabel: "GitHub MCP URL",
    displaySaved: resolveGithubMcpUrl(current.githubMcpUrl),
  });
  if (!mcp.ok) return mcp;
  return { ok: true, searxngUrl: searx.url, githubMcpUrl: mcp.url };
}

export function saveSettings(
  input: { searxngUrl?: string; tavilyApiKey?: string | null; githubToken?: string | null; githubMcpUrl?: string },
  connectionSecrets: readonly ConnectionSecrets[] = [],
) {
  const current = getSettings();
  const resolved = resolveSettingsUrls(input, current);
  if (!resolved.ok) throw new Error(resolved.error);
  const values = {
    id: 1,
    searxngUrl: resolved.searxngUrl,
    tavilyApiKey: input.tavilyApiKey === null ? "" : input.tavilyApiKey?.trim() || current.tavilyApiKey,
    githubToken: input.githubToken === null ? "" : input.githubToken?.trim() || current.githubToken,
    githubMcpUrl: resolved.githubMcpUrl,
    updatedAt: new Date(),
  };
  getDb().insert(settings).values(values).onConflictDoUpdate({ target: settings.id, set: values }).run();
  return toPublicSettings(values, connectionSecrets);
}
