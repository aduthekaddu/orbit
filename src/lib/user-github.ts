import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Redactor, redactUrl, resolveMaskedUrl } from "./chat-errors";
import { redactionSecrets } from "./connections";
import { getDb } from "./db";
import { toolStatus, userGithub } from "./db/schema";
import { readEnv } from "./env";
import { decryptSecret, encryptSecret, GITHUB_AAD, SecretUnreadable } from "./secrets";
import type { UserId, Viewer } from "./session";
import { githubMcpTarget, resolveGithubMcpUrl } from "./tools/github";

export type UserGithubSecrets = {
  githubToken: string;
  githubMcpUrl: string;
};

export type UserGithubRecord = UserGithubSecrets & {
  githubTokenSet: boolean;
  githubTokenReadable: boolean;
};

export type PublicUserGithub = Omit<UserGithubRecord, "githubToken">;

type GithubPatch = { githubToken?: string | null; githubMcpUrl?: string };
const storedGithub = z.object({ tokenCiphertext: z.string(), mcpUrl: z.string() });

function githubFrom(row: unknown): UserGithubRecord {
  const { tokenCiphertext, mcpUrl: githubMcpUrl } = storedGithub.parse(row);
  const githubTokenSet = tokenCiphertext !== "";
  let githubToken = "";
  let githubTokenReadable = true;
  if (githubTokenSet) {
    try {
      githubToken = decryptSecret(tokenCiphertext, GITHUB_AAD);
    } catch (error) {
      if (!(error instanceof SecretUnreadable)) throw error;
      githubTokenReadable = false;
    }
  }
  return { githubToken, githubMcpUrl, githubTokenSet, githubTokenReadable };
}

export function getGithub(userId: UserId): UserGithubRecord {
  const row = getDb().select().from(userGithub).where(eq(userGithub.userId, userId)).get();
  return githubFrom(row ?? { tokenCiphertext: "", mcpUrl: "" });
}

export function toPublicGithub(userId: UserId, row = getGithub(userId)): PublicUserGithub {
  const redact = new Redactor(row, ...redactionSecrets(userId));
  return {
    githubTokenSet: row.githubTokenSet,
    githubTokenReadable: row.githubTokenReadable,
    githubMcpUrl: redactUrl(resolveGithubMcpUrl(row.githubMcpUrl), redact),
  };
}

export function resolveGithubUrl(userId: UserId, input: Pick<GithubPatch, "githubMcpUrl">, current: UserGithubRecord) {
  const resolved = resolveMaskedUrl({
    submitted: input.githubMcpUrl,
    saved: current.githubMcpUrl,
    redact: new Redactor(current, ...redactionSecrets(userId)),
    normalize: (value) => value.trim(),
    fieldLabel: "GitHub MCP URL",
    displaySaved: resolveGithubMcpUrl(current.githubMcpUrl),
  });
  if (!resolved.ok || input.githubMcpUrl === undefined) return resolved;
  const target = githubMcpTarget(resolved.url);
  return target.ok ? resolved : target;
}

export function saveGithub(userId: UserId, input: GithubPatch) {
  return getDb().transaction((tx) => {
    const current = tx.select().from(userGithub).where(eq(userGithub.userId, userId)).get();
    const resolved = resolveGithubUrl(userId, input, githubFrom(current ?? { tokenCiphertext: "", mcpUrl: "" }));
    if (!resolved.ok) return resolved;

    const token = input.githubToken?.trim();
    const tokenCiphertext = input.githubToken === null ? "" : token ? encryptSecret(token, GITHUB_AAD) : current?.tokenCiphertext ?? "";
    const values = { tokenCiphertext, mcpUrl: resolved.url, updatedAt: new Date() };
    const row = tx.insert(userGithub).values({ userId, ...values })
      .onConflictDoUpdate({ target: userGithub.userId, set: values }).returning().get();
    // A GitHub status found with the old token or URL says nothing about the new ones.
    if (tokenCiphertext !== (current?.tokenCiphertext ?? "") || resolved.url !== (current?.mcpUrl ?? "")) {
      tx.delete(toolStatus).where(and(eq(toolStatus.userId, userId), eq(toolStatus.toolId, "github"))).run();
    }
    return { ok: true, settings: toPublicGithub(userId, githubFrom(row)) } as const;
  }, { behavior: "immediate" });
}

export function trySeedAdminGithub(viewer: Viewer) {
  if (viewer.role !== "admin") return;
  const token = readEnv("ORBIT_GITHUB_TOKEN");
  if (!token) return;
  try {
    const db = getDb();
    if (db.select({ id: userGithub.userId }).from(userGithub).where(eq(userGithub.userId, viewer.id)).get()) return;
    db.insert(userGithub).values({ userId: viewer.id, tokenCiphertext: encryptSecret(token, GITHUB_AAD), updatedAt: new Date() })
      .onConflictDoNothing({ target: userGithub.userId }).run();
  } catch {
    console.error("GitHub token seed failed");
  }
}
