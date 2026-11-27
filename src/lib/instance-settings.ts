import { eq } from "drizzle-orm";
import { z } from "zod";
import { Redactor, redactUrl, resolveMaskedUrl } from "./chat-errors";
import { redactionSecrets } from "./connections";
import { accountCount, getDb, type OrbitDb } from "./db";
import { instanceSettings } from "./db/schema";
import { parseHostingMode, policyFor, type HostingMode } from "./policy";
import { sandboxEnabled } from "./sandbox/enabled";
import { decryptSecret, encryptSecret, SecretUnreadable, TAVILY_AAD } from "./secrets";
import type { UserId } from "./session";

export const SANDBOX_PREFERENCES = ["on", "off"] as const;
export type SandboxPreference = (typeof SANDBOX_PREFERENCES)[number];

export type InstanceSearchSecrets = {
  searxngUrl: string;
  tavilyApiKey: string;
};

export type InstanceSettingsRecord = InstanceSearchSecrets & {
  hostingMode: HostingMode;
  tavilyKeySet: boolean;
  tavilyKeyReadable: boolean;
  sandbox: SandboxPreference;
  dreamHour: number;
};

export type PublicInstanceSettings = Omit<InstanceSettingsRecord, "hostingMode" | "tavilyApiKey" | "sandbox"> & {
  hostingMode: HostingMode["kind"];
  sandboxAvailable: boolean;
  sandbox: boolean;
};

type InstancePatch = {
  searxngUrl?: string;
  tavilyApiKey?: string | null;
  sandbox?: SandboxPreference;
  dreamHour?: number;
};

const storedSettings = z.object({
  hostingMode: z.string(),
  searxngUrl: z.string(),
  tavilyKeyCiphertext: z.string(),
  sandbox: z.enum(SANDBOX_PREFERENCES),
  dreamHour: z.number().int().min(0).max(23),
});

const onlyInstance = eq(instanceSettings.id, 1);
function readInstance(db: Pick<OrbitDb, "select">) {
  return storedSettings.parse(db.select().from(instanceSettings).where(onlyInstance).get());
}

function instanceFrom(row: z.infer<typeof storedSettings>): InstanceSettingsRecord {
  const hostingMode = parseHostingMode(row.hostingMode);
  const { searxngUrl, sandbox, dreamHour, tavilyKeyCiphertext } = row;
  const tavilyKeySet = tavilyKeyCiphertext !== "";
  let tavilyApiKey = "";
  let tavilyKeyReadable = true;
  if (tavilyKeySet) {
    try {
      tavilyApiKey = decryptSecret(tavilyKeyCiphertext, TAVILY_AAD);
    } catch (error) {
      if (!(error instanceof SecretUnreadable)) throw error;
      tavilyKeyReadable = false;
    }
  }
  return { hostingMode, searxngUrl, tavilyApiKey, tavilyKeySet, tavilyKeyReadable, sandbox, dreamHour };
}

export function getInstance(): InstanceSettingsRecord {
  return instanceFrom(readInstance(getDb()));
}

export function signupOpen() {
  return policyFor(getInstance().hostingMode).openWithoutInvite(accountCount());
}

export function sandboxActive(instance: Pick<InstanceSettingsRecord, "sandbox">): boolean {
  return sandboxEnabled() && instance.sandbox === "on";
}

export function toPublicInstance(adminId: UserId, row = getInstance()): PublicInstanceSettings {
  const redact = new Redactor(row, ...redactionSecrets(adminId));
  return {
    hostingMode: row.hostingMode.kind,
    searxngUrl: redactUrl(row.searxngUrl, redact),
    tavilyKeySet: row.tavilyKeySet,
    tavilyKeyReadable: row.tavilyKeyReadable,
    sandboxAvailable: sandboxEnabled(),
    sandbox: sandboxActive(row),
    dreamHour: row.dreamHour,
  };
}

export function resolveInstanceUrls(adminId: UserId, input: Pick<InstancePatch, "searxngUrl">, current: InstanceSettingsRecord) {
  return resolveMaskedUrl({
    submitted: input.searxngUrl,
    saved: current.searxngUrl,
    redact: new Redactor(current, ...redactionSecrets(adminId)),
    normalize: (value) => value.trim().replace(/\/+$/, ""),
    fieldLabel: "SearXNG URL",
  });
}

export function saveInstance(adminId: UserId, input: InstancePatch) {
  return getDb().transaction((tx) => {
    const stored = readInstance(tx);
    const resolved = resolveInstanceUrls(adminId, input, instanceFrom(stored));
    if (!resolved.ok) return resolved;

    const key = input.tavilyApiKey?.trim();
    const updated = tx.update(instanceSettings).set({
      searxngUrl: resolved.url,
      tavilyKeyCiphertext: input.tavilyApiKey === null ? "" : key ? encryptSecret(key, TAVILY_AAD) : undefined,
      sandbox: input.sandbox,
      dreamHour: input.dreamHour,
      updatedAt: new Date(),
    }).where(onlyInstance).returning().get();
    return { ok: true, settings: toPublicInstance(adminId, instanceFrom(storedSettings.parse(updated))) } as const;
  }, { behavior: "immediate" });
}
