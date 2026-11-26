import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import { DEFAULT_APPEARANCE } from "./appearance";
import { getDb } from "./db";
import * as schema from "./db/schema";
import { getPreferences, savePreferences } from "./preferences";

const originalCwd = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preferences-"));

function addUser(id: string) {
  const now = new Date();
  getDb().insert(schema.user).values({ id, name: id, email: `${id}@orbit.local`, emailVerified: false, createdAt: now, updatedAt: now }).run();
}

function rowsFor(userId: string) {
  return getDb().select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).all();
}

before(() => {
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);
  addUser("u-a");
});

after(() => {
  getDb().$client.close();
  process.chdir(originalCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a user with no saved row gets the defaults", () => {
  assert.deepEqual(getPreferences("u-a"), DEFAULT_APPEARANCE);
  assert.equal(rowsFor("u-a").length, 0);
});

test("a patch saves one field and a later patch keeps it", () => {
  assert.deepEqual(savePreferences("u-a", { theme: "light" }), { ...DEFAULT_APPEARANCE, theme: "light" });
  assert.deepEqual(savePreferences("u-a", { textSize: "lg" }), { ...DEFAULT_APPEARANCE, theme: "light", textSize: "lg" });
  assert.deepEqual(getPreferences("u-a"), { ...DEFAULT_APPEARANCE, theme: "light", textSize: "lg" });
  assert.deepEqual(getPreferences("someone-else"), DEFAULT_APPEARANCE);
});

test("the same patch twice leaves one row with the same values", () => {
  const first = savePreferences("u-a", { accent: "sky", chatWidth: "wide" });
  const second = savePreferences("u-a", { accent: "sky", chatWidth: "wide" });
  assert.deepEqual(second, first);
  assert.equal(rowsFor("u-a").length, 1);
});

test("a bad stored value reads as its default and the next save replaces it", () => {
  getDb().update(schema.userPreferences).set({ replyFont: "comic" }).where(eq(schema.userPreferences.userId, "u-a")).run();
  assert.equal(getPreferences("u-a").replyFont, "sans");
  assert.equal(getPreferences("u-a").accent, "sky");
  savePreferences("u-a", { replyFont: "serif" });
  assert.equal(rowsFor("u-a")[0].replyFont, "serif");
});

test("deleting the user deletes their preferences", () => {
  getDb().delete(schema.user).where(eq(schema.user.id, "u-a")).run();
  assert.equal(rowsFor("u-a").length, 0);
});
