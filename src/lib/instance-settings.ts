import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { Redactor, redactUrl, resolveMaskedUrl } from "./chat-errors";
import { redactionSecrets } from "./connections";
import { accountCount, getDb, type OrbitDb } from "./db";
import { instanceSettings, invites } from "./db/schema";
import { parseHostingMode, policyFor, switchMode, type HostingMode, type SignupMode } from "./policy";
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
  signupMode: SignupMode;
  sandboxAvailable: boolean;
  sandbox: boolean;
};

type InstancePatch = {
  hostingMode?: HostingMode["kind"];
  signupMode?: SignupMode;
  searxngUrl?: string;
  tavilyApiKey?: string | null;
  sandbox?: SandboxPreference;
  dreamHour?: number;
};

const storedSettings = z.object({
  hostingMode: z.string(),
  signupMode: z.string(),
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
  const hostingMode = parseHostingMode(row.hostingMode, row.signupMode);
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

export function getInstance(db: Pick<OrbitDb, "select"> = getDb()): InstanceSettingsRecord {
  return instanceFrom(readInstance(db));
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
    signupMode: row.hostingMode.kind === "community" ? row.hostingMode.signup : "invite",
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
    const current = instanceFrom(stored);
    const hosting = input.hostingMode ?? current.hostingMode.kind;
    if (hosting !== "community" && input.signupMode === "open") {
      return { ok: false, error: "Signup mode applies to Community mode only.", status: 400 } as const;
    }
    const signup = input.signupMode ?? (current.hostingMode.kind === "community" ? current.hostingMode.signup : "invite");
    const mode = parseHostingMode(hosting, signup);
    const change = switchMode(current.hostingMode, mode, accountCount(tx));
    if (!change.ok) return { ok: false, error: "Remove other accounts first.", status: 409 } as const;

    const resolved = resolveInstanceUrls(adminId, input, current);
    if (!resolved.ok) return resolved;

    if (change.deletePendingInvites) tx.delete(invites).where(isNull(invites.usedAt)).run();

    const key = input.tavilyApiKey?.trim();
    const updated = tx.update(instanceSettings).set({
      hostingMode: mode.kind,
      signupMode: change.resetSignupMode ? "invite" : mode.kind === "community" ? mode.signup : undefined,
      searxngUrl: resolved.url,
      tavilyKeyCiphertext: input.tavilyApiKey === null ? "" : key ? encryptSecret(key, TAVILY_AAD) : undefined,
      sandbox: input.sandbox,
      dreamHour: input.dreamHour,
      updatedAt: new Date(),
    }).where(onlyInstance).returning().get();
    return { ok: true, settings: toPublicInstance(adminId, instanceFrom(storedSettings.parse(updated))) } as const;
  }, { behavior: "immediate" });
}
