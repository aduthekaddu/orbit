import { eq } from "drizzle-orm";
import { normalizeBaseUrl } from "./base-url";
import { db } from "./db";
import { settings } from "./db/schema";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SettingsRecord = {
  baseUrl: string;
  apiKey: string;
  searxngUrl: string;
  tavilyApiKey: string;
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
    model: row.model,
    reasoningEffort: asEffort(row.reasoningEffort),
  };
}

export function toPublicSettings(row: SettingsRecord | null): PublicSettings {
  return {
    baseUrl: row?.baseUrl ?? "",
    model: row?.model ?? "",
    reasoningEffort: row?.reasoningEffort ?? "medium",
    keySet: Boolean(row?.apiKey),
    searxngUrl: row?.searxngUrl ?? "",
    tavilyKeySet: Boolean(row?.tavilyApiKey),
  };
}

export function saveSettings(input: {
  baseUrl: string;
  apiKey?: string;
  searxngUrl?: string;
  tavilyApiKey?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}) {
  const current = getSettings();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const sameSavedBase = current !== null && normalizeBaseUrl(current.baseUrl) === baseUrl;
  const requestedKey = input.apiKey?.trim() ?? "";
  const apiKey = requestedKey || (sameSavedBase ? current.apiKey : "");
  const values = {
    id: 1,
    baseUrl,
    apiKey,
    searxngUrl: input.searxngUrl?.trim().replace(/\/+$/, "") ?? current?.searxngUrl ?? "",
    tavilyApiKey: input.tavilyApiKey?.trim() || current?.tavilyApiKey || "",
    model: input.model.trim(),
    reasoningEffort: input.reasoningEffort,
    updatedAt: new Date(),
  };
  db.insert(settings).values(values).onConflictDoUpdate({ target: settings.id, set: values }).run();
  return toPublicSettings(values);
}
