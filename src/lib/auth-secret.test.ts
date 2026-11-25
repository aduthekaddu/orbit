import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { dataDirectory } from "./paths";

test("reading an existing auth secret restricts it to the owner", async () => {
  const secretFile = path.join(dataDirectory(), "auth-secret");
  fs.writeFileSync(secretFile, "existing-secret-0123456789abcdef0123456789abcdef0123456789abcdef", { mode: 0o644 });
  fs.chmodSync(secretFile, 0o644);

  process.env.BETTER_AUTH_URL = "http://127.0.0.1:3210";
  delete process.env.BETTER_AUTH_SECRET;

  await import("./auth");

  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
});
