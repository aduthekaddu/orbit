import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import { DEFAULT_APPEARANCE } from "./appearance";
import { getDb } from "./db";
import * as schema from "./db/schema";
import { getMemoryEnabled, getPreferences, savePreferences } from "./preferences";
import type { UserId } from "./session";

const memberA = "u-a" as UserId;
const memberB = "u-b" as UserId;
const defaults = { ...DEFAULT_APPEARANCE, memory: "on" };

function addUser(id: string) {
  const now = new Date();
  getDb().insert(schema.user).values({ id, name: id, email: `${id}@orbit.local`, emailVerified: false, createdAt: now, updatedAt: now }).run();
}

function rowsFor(userId: string) {
  return getDb().select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).all();
}

before(() => {
  addUser(memberA);
  addUser(memberB);
});

after(() => {
  getDb().$client.close();
});

test("a user with no saved row gets the defaults", () => {
  assert.deepEqual(getPreferences(memberA), defaults);
  assert.equal(rowsFor(memberA).length, 0);
});

test("a patch saves one field and a later patch keeps it", () => {
  assert.deepEqual(savePreferences(memberA, { theme: "light" }), { ...defaults, theme: "light" });
  assert.deepEqual(savePreferences(memberA, { textSize: "lg" }), { ...defaults, theme: "light", textSize: "lg" });
  assert.deepEqual(getPreferences(memberA), { ...defaults, theme: "light", textSize: "lg" });
  assert.deepEqual(getPreferences(memberB), defaults);
});

test("the same patch twice leaves one row with the same values", () => {
  const first = savePreferences(memberA, { accent: "sky", chatWidth: "wide" });
  const second = savePreferences(memberA, { accent: "sky", chatWidth: "wide" });
  assert.deepEqual(second, first);
  assert.equal(rowsFor(memberA).length, 1);
});

test("a bad stored value reads as its default and the next save replaces it", () => {
  getDb().update(schema.userPreferences).set({ replyFont: "comic" }).where(eq(schema.userPreferences.userId, memberA)).run();
  assert.equal(getPreferences(memberA).replyFont, "sans");
  assert.equal(getPreferences(memberA).accent, "sky");
  savePreferences(memberA, { replyFont: "serif" });
  assert.equal(rowsFor(memberA)[0].replyFont, "serif");
});

test("switching memory off preserves other settings and only affects that user", () => {
  assert.equal(getMemoryEnabled(memberA), true);
  assert.equal(getMemoryEnabled(memberB), true);
  assert.equal(savePreferences(memberA, { memory: "off" }).memory, "off");
  assert.equal(getMemoryEnabled(memberA), false);
  assert.equal(getMemoryEnabled(memberB), true);
  assert.equal(savePreferences(memberA, { theme: "light" }).memory, "off");
  assert.equal(getPreferences(memberB).memory, "on");
});

test("deleting the user deletes their preferences", () => {
  getDb().delete(schema.user).where(eq(schema.user.id, memberA)).run();
  assert.equal(rowsFor(memberA).length, 0);
});
