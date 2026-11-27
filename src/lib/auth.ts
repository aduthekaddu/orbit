import path from "node:path";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { LOCAL_AUTH_URL, resolveAuthBaseUrl, resolveTrustedOrigins } from "./auth-origins";
import { trySeedConnection } from "./connections";
import { accountCount, getDb } from "./db";
import { account, session, user, verification } from "./db/schema";
import { readEnv } from "./env";
import { dataDirectory } from "./paths";
import { getInstance } from "./instance-settings";
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

function createAuth() {
  const options = orbitAuthOptions();
  const auth = betterAuth({
    ...options,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const decision = getDb().transaction(() =>
              policyFor(getInstance().hostingMode).signup({ accounts: accountCount(), invite: "none" }),
              { behavior: "immediate" },
            );
            if (!decision.ok) throw new APIError("FORBIDDEN", { message: "Signup is closed" });
            return { data: { ...user, role: decision.role } };
          },
          after: async (created) => {
            if (created.role !== "admin") return;
            const viewer = parseViewer(created);
            trySeedConnection(viewer);
            trySeedAdminGithub(viewer);
          },
        },
      },
    },
    // Clients can forge X-Forwarded-For. Reading no header keeps a forged value from getting its
    // own rate-limit bucket, so every client shares one bucket per auth path.
    advanced: { ipAddress: { ipAddressHeaders: [] } },
    telemetry: { enabled: false },
  });
  return { auth, trustedOrigins: options.trustedOrigins };
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
