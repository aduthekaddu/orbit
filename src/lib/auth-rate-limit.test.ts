import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { getDb, type OrbitDb } from "./db";

const origin = "http://127.0.0.1:3210";
const email = "owner@orbit.local";
// Next.js types NODE_ENV as read-only, and this test has to set it.
const env: Record<string, string | undefined> = process.env;
const originalNodeEnv = env.NODE_ENV;
const originalDataDir = process.env.ORBIT_DATA_DIR;
let dataDir = "";
let auth: ReturnType<typeof import("./auth").getAuth>;
let db: OrbitDb | undefined;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-auth-rate-limit-"));
  process.env.ORBIT_DATA_DIR = dataDir;
  // better-auth turns its rate limit on only when it sees NODE_ENV=production as it loads.
  env.NODE_ENV = "production";
  const { getAuth } = await import("./auth");
  auth = getAuth();
  db = getDb();
  await auth.api.signUpEmail({ body: { name: "Owner", email, password: "right-password" } });
});

after(() => {
  db?.$client.close();
  if (originalNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = originalNodeEnv;
  if (originalDataDir === undefined) delete process.env.ORBIT_DATA_DIR;
  else process.env.ORBIT_DATA_DIR = originalDataDir;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function wrongPasswordSignIn(forwardedFor: string) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": forwardedFor },
      body: JSON.stringify({ email, password: "wrong-password" }),
    }),
  );
  return response.status;
}

test("a new X-Forwarded-For value on each sign-in does not reset the rate limit", async () => {
  const statuses = [];
  for (const n of [1, 2, 3, 4]) statuses.push(await wrongPasswordSignIn(`10.0.0.${n}`));
  assert.deepEqual(statuses, [401, 401, 401, 429]);
});
