import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { getAuth } from "./auth";
import { getDb } from "./db";
import { dataDirectory } from "./paths";

const originalUrl = process.env.BETTER_AUTH_URL;
const originalSecret = process.env.BETTER_AUTH_SECRET;

after(() => {
  getDb().$client.close();
  if (originalUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
});

test("reading an existing auth secret restricts it to the owner", () => {
  const secretFile = path.join(dataDirectory(), "auth-secret");
  fs.writeFileSync(secretFile, "existing-secret-0123456789abcdef0123456789abcdef0123456789abcdef", { mode: 0o644 });
  fs.chmodSync(secretFile, 0o644);

  process.env.BETTER_AUTH_URL = "http://127.0.0.1:3210";
  delete process.env.BETTER_AUTH_SECRET;

  getAuth();

  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
});
