import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { DEFAULT_APPEARANCE } from "@/lib/appearance";
import { getDb, type OrbitDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const USER_ID = "u-preferences-route";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preferences-route-"));
const stubFile = path.join(sandbox, "session-stub.cjs");
fs.writeFileSync(
  stubFile,
  `exports.getSession = async () => (globalThis.orbitTestSignedOut ? null : { user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(stubFile).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let route: typeof import("./route");
const flags = globalThis as { orbitTestSignedOut?: boolean };
let db: OrbitDb | undefined;
const originalCwd = process.cwd();

function patch(body: string) {
  return route.PATCH(new Request("http://127.0.0.1/api/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body }));
}

function rowCount() {
  return db!.select().from(schema.userPreferences).all().length;
}

before(async () => {
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);
  db = getDb();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Prefs", email: "prefs@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  route = await import("./route");
});

after(() => {
  db?.$client.close();
  process.chdir(originalCwd);
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("GET and PATCH answer 401 without a session", async () => {
  flags.orbitTestSignedOut = true;
  try {
    assert.equal((await route.GET()).status, 401);
    assert.equal((await patch(JSON.stringify({ theme: "light" }))).status, 401);
    assert.equal(rowCount(), 0);
  } finally {
    delete flags.orbitTestSignedOut;
  }
});

test("GET returns the defaults before anything is saved", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), DEFAULT_APPEARANCE);
});

test("PATCH saves the changed fields and returns the whole appearance", async () => {
  const first = await patch(JSON.stringify({ theme: "light" }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ...DEFAULT_APPEARANCE, theme: "light" });
  const second = await patch(JSON.stringify({ textSize: "xl", accent: "rose" }));
  assert.deepEqual(await second.json(), { ...DEFAULT_APPEARANCE, theme: "light", textSize: "xl", accent: "rose" });
  assert.deepEqual(await (await route.GET()).json(), { ...DEFAULT_APPEARANCE, theme: "light", textSize: "xl", accent: "rose" });
});

test("PATCH rejects an empty, unknown, or invalid body without writing", async () => {
  const before = await (await route.GET()).json();
  for (const body of ["{}", JSON.stringify({ colour: "red" }), JSON.stringify({ theme: "neon" }), JSON.stringify({ theme: "light", extra: 1 }), "{not json", "null", "[]"]) {
    const response = await patch(body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { error: "Invalid appearance setting." });
  }
  assert.deepEqual(await (await route.GET()).json(), before);
});
