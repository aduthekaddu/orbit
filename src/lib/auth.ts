import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { LOCAL_AUTH_URL, resolveAuthBaseUrl, resolveTrustedOrigins } from "./auth-origins";
import { trySeedConnection } from "./connections";
import { accountCount, getDb } from "./db";
import { account, session, user, verification } from "./db/schema";
import { readEnv } from "./env";
import { getInstance } from "./instance-settings";
import { claimInvite, installInviteSpend, pendingInviteHash, spendInvite } from "./invites";
import { dataDirectory } from "./paths";
import { parseViewer, policyFor } from "./policy";
import { readOrCreateSecretFile } from "./secrets";
import { trySeedAdminGithub } from "./user-github";

function authSecret() {
  return readEnv("BETTER_AUTH_SECRET") ?? readOrCreateSecretFile(path.join(dataDirectory(), "auth-secret"));
}

export function orbitAuthOptions() {
  const localURL = readEnv("BETTER_AUTH_URL") ?? LOCAL_AUTH_URL;
  const publicURL = readEnv("ORBIT_PUBLIC_URL");
  const trustedOrigins = resolveTrustedOrigins(localURL, readEnv("ORBIT_TRUSTED_ORIGINS"), publicURL);
  const db = getDb();
  return {
    baseURL: resolveAuthBaseUrl({ BETTER_AUTH_URL: localURL, ORBIT_PUBLIC_URL: publicURL }),
    secret: authSecret(),
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
    }),
    user: {
      additionalFields: {
        role: { type: "string", input: false, returned: true, defaultValue: "member" },
      },
    },
  } as const;
}

type AuthRequest = { finished: Promise<void>; claimedInviteHash: string | null };
const globalAuth = globalThis as typeof globalThis & {
  __orbitActiveSignups?: Set<Promise<void>>;
  __orbitAuthRequest?: AsyncLocalStorage<AuthRequest>;
};
const activeSignups = globalAuth.__orbitActiveSignups ??= new Set();
const authRequest = globalAuth.__orbitAuthRequest ??= new AsyncLocalStorage<AuthRequest>();

export async function afterActiveSignups<T>(mutate: () => T): Promise<T> {
  while (activeSignups.size > 0) await Promise.allSettled(activeSignups);
  return mutate();
}

function createAuth() {
  const options = orbitAuthOptions();
  installInviteSpend(getDb(), () => authRequest.getStore()?.claimedInviteHash ?? null);
  const auth = betterAuth({
    ...options,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const token = ctx?.getHeader?.("x-orbit-invite")?.trim() || null;
            const currentRequest = authRequest.getStore();
            const { approved, claimedInviteHash } = getDb().transaction((tx) => {
              const accounts = accountCount(tx);
              const now = Date.now();
              const tokenHash = accounts > 0 && token ? pendingInviteHash(tx, token, now) : null;
              const invite = tokenHash ? "valid" : accounts > 0 && token ? "invalid" : "none";
              const decision = policyFor(getInstance(tx).hostingMode).signup({ accounts, invite });
              if (!decision.ok) {
                throw new APIError("FORBIDDEN", { message: decision.reason === "invite-invalid" ? "Invite not valid" : "Signup is closed" });
              }
              if (decision.invite === "consume" && (!tokenHash || !claimInvite(tx, tokenHash, now))) {
                throw new APIError("FORBIDDEN", { message: "Invite not valid" });
              }
              return {
                approved: { data: { ...user, role: decision.role } },
                claimedInviteHash: decision.invite === "consume" ? tokenHash : null,
              };
            }, { behavior: "immediate" });
            // Better Auth awaits between approval and the user INSERT.
            if (currentRequest) {
              currentRequest.claimedInviteHash = claimedInviteHash;
              activeSignups.add(currentRequest.finished);
            }
            return approved;
          },
          after: async (created, ctx) => {
            const viewer = parseViewer(created);
            if (viewer.role === "admin") {
              trySeedConnection(viewer);
              trySeedAdminGithub(viewer);
              return;
            }
            if (!authRequest.getStore()) {
              const token = ctx?.getHeader?.("x-orbit-invite")?.trim();
              if (token) spendInvite(token, viewer.id);
            }
          },
        },
      },
    },
    // Clients can forge X-Forwarded-For. Reading no header keeps a forged value from getting its
    // own rate-limit bucket, so every client shares one bucket per auth path.
    advanced: { ipAddress: { ipAddressHeaders: [] } },
    telemetry: { enabled: false },
  });
  function handler(request: Request) {
    const { promise, resolve } = Promise.withResolvers<void>();
    return authRequest.run({ finished: promise, claimedInviteHash: null }, async () => {
      try {
        return await auth.handler(request);
      } finally {
        activeSignups.delete(promise);
        resolve();
      }
    });
  }

  return { auth: { ...auth, handler }, trustedOrigins: options.trustedOrigins };
}

type AuthState = ReturnType<typeof createAuth>;

let cached: AuthState | undefined;

function authState(): AuthState {
  cached ??= createAuth();
  return cached;
}

export function getAuth() {
  return authState().auth;
}

export function getTrustedOrigins() {
  return authState().trustedOrigins;
}
