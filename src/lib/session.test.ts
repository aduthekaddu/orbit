import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { LOCAL_AUTH_URL } from "./auth-origins";
import { getAuth } from "./auth";
import { getDb } from "./db";

const DAY = 86_400_000;
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "ORBIT_PUBLIC_URL", "ORBIT_TRUSTED_ORIGINS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-session-test-"));
const headersStub = path.join(sandbox, "next-headers.cjs");
fs.writeFileSync(
  headersStub,
  "exports.headers = async () => globalThis.__orbitSessionTestHeaders ?? new Headers();\n",
);
const headersStubUrl = pathToFileURL(headersStub).href;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") return { url: headersStubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const globalSlot = globalThis as { __orbitSessionTestHeaders?: Headers };

let getSession: typeof import("./session").getSession;
let sessionCookie = "";
let sessionToken = "";

function readExpiresAt(token: string) {
  const row = getDb().$client.prepare("SELECT expires_at AS expiresAt FROM session WHERE token = ?").get(token) as
    | { expiresAt: number }
    | undefined;
  return row?.expiresAt;
}

before(async () => {
  process.env.BETTER_AUTH_URL = LOCAL_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ORBIT_PUBLIC_URL;
  delete process.env.ORBIT_TRUSTED_ORIGINS;
  ({ getSession } = await import("./session"));
  const signedUp = await getAuth().api.signUpEmail({
    body: { name: "Session Test", email: "session-test@orbit.local", password: "session-test-password-1" },
    headers: new Headers({ origin: LOCAL_AUTH_URL }),
    returnHeaders: true,
  });
  const line = signedUp.headers.getSetCookie().find((entry) => entry.startsWith("better-auth.session_token="));
  assert.ok(line, "signUpEmail must return a session cookie");
  assert.ok(signedUp.response.token, "signUpEmail must return a session token");
  sessionCookie = line.split(";")[0];
  sessionToken = signedUp.response.token;
});

after(() => {
  hooks.deregister();
  delete globalSlot.__orbitSessionTestHeaders;
  getDb().$client.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("getSession reads a due-for-refresh session without extending SQLite behind the proxy", async () => {
  const backdatedExpiresAt = Date.now() + 6 * DAY - 60_000;
  getDb().$client
    .prepare("UPDATE session SET expires_at = ?, updated_at = ? WHERE token = ?")
    .run(backdatedExpiresAt, Date.now() - DAY - 60_000, sessionToken);

  globalSlot.__orbitSessionTestHeaders = new Headers({ cookie: sessionCookie });
  const result = await getSession();
  assert.equal(result?.session.token, sessionToken);
  assert.equal(readExpiresAt(sessionToken), backdatedExpiresAt);
});

test("getSession still rejects an expired session", async () => {
  getDb().$client.prepare("UPDATE session SET expires_at = ? WHERE token = ?").run(Date.now() - 60_000, sessionToken);

  globalSlot.__orbitSessionTestHeaders = new Headers({ cookie: sessionCookie });
  const result = await getSession();
  assert.equal(result, null);
});
