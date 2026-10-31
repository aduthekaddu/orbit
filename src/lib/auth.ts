import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { db, signupOpen } from "./db";
import { account, session, user, verification } from "./db/schema";
import { readEnv } from "./env";
import { dataDirectory } from "./paths";

function authSecret() {
  const fromEnv = readEnv("BETTER_AUTH_SECRET");
  if (fromEnv) return fromEnv;
  const file = path.join(dataDirectory(), "auth-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const baseURL = readEnv("BETTER_AUTH_URL") ?? "http://127.0.0.1:3210";

function trustedOrigins() {
  const origins = new Set([
    "http://127.0.0.1:3210",
    "http://localhost:3210",
    "http://127.0.0.1:3211",
    "http://localhost:3211",
  ]);
  try {
    origins.add(new URL(baseURL).origin);
  } catch {
    // A malformed BETTER_AUTH_URL leaves the defaults in place.
  }
  for (const origin of readEnv("ORBIT_TRUSTED_ORIGINS")?.split(",") ?? []) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
}

export const auth = betterAuth({
  baseURL,
  secret: authSecret(),
  trustedOrigins: trustedOrigins(),
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
  telemetry: { enabled: false },
});
