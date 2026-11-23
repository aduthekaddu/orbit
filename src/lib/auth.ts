import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { LOCAL_AUTH_URL, resolveAuthBaseUrl, resolveTrustedOrigins } from "./auth-origins";
import { db, signupOpen } from "./db";
import { account, session, user, verification } from "./db/schema";
import { readEnv } from "./env";
import { dataDirectory } from "./paths";

function authSecret() {
  const fromEnv = readEnv("BETTER_AUTH_SECRET");
  if (fromEnv) return fromEnv;
  const file = path.join(dataDirectory(), "auth-secret");
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600);
    return fs.readFileSync(file, "utf8").trim();
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const localURL = readEnv("BETTER_AUTH_URL") ?? LOCAL_AUTH_URL;
const publicURL = readEnv("ORBIT_PUBLIC_URL");

export const auth = betterAuth({
  baseURL: resolveAuthBaseUrl({ BETTER_AUTH_URL: localURL, ORBIT_PUBLIC_URL: publicURL }),
  secret: authSecret(),
  // The local origin stays trusted, so 127.0.0.1:3210 still signs in when a public URL is set.
  trustedOrigins: resolveTrustedOrigins(localURL, readEnv("ORBIT_TRUSTED_ORIGINS"), publicURL),
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          if (!signupOpen()) {
            throw new APIError("FORBIDDEN", { message: "Signup is closed" });
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
