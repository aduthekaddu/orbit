import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

type Modules = {
  db: typeof import("./db").db;
  schema: typeof import("./db/schema");
  persistIncoming: typeof import("./messages").persistIncoming;
  keepOnlyMessages: typeof import("./messages").keepOnlyMessages;
  listMessages: typeof import("./messages").listMessages;
  upsertMessage: typeof import("./messages").upsertMessage;
};

let mods: Modules;

before(async () => {
  const repo = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-chat-write-"));
  fs.mkdirSync(path.join(sandbox, "data"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  const dbModule = await import("./db");
  const schema = await import("./db/schema");
  const messageModule = await import("./messages");
  mods = {
    db: dbModule.db,
    schema,
    persistIncoming: messageModule.persistIncoming,
    keepOnlyMessages: messageModule.keepOnlyMessages,
    listMessages: messageModule.listMessages,
    upsertMessage: messageModule.upsertMessage,
  };

  const now = new Date();
  mods.db.insert(mods.schema.user).values({ id: "u1", name: "Test", email: "test@orbit.local" }).run();
  for (const id of ["c-stale", "c-regen", "c-prefix", "c-parts", "c-concurrent"]) {
    mods.db.insert(mods.schema.chats).values({ id, userId: "u1", title: id, createdAt: now, updatedAt: now }).run();
  }
});

type Incoming = { id: string; role: "user" | "assistant" | "system"; parts?: unknown };

function message(id: string, role: "user" | "assistant", text: string): Incoming {
  return { id, role, parts: [{ type: "text", text }] };
}

function write(chatId: string, incoming: Incoming[]) {
  const keptIds = incoming.filter((entry) => entry.parts).map((entry) => entry.id);
  assert.equal(mods.persistIncoming(chatId, incoming), true);
  mods.keepOnlyMessages(chatId, keptIds);
}

function answer(chatId: string, id: string, text: string, replyTo: string) {
  assert.equal(mods.upsertMessage(chatId, message(id, "assistant", text), replyTo), true);
}

function ids(chatId: string) {
  return mods.listMessages(chatId).map((entry) => entry.id);
}

test("a stale tab's prefix keeps newer stored turns", () => {
  write("c-stale", [message("s1", "user", "first question")]);
  answer("c-stale", "s2", "first answer", "s1");
  write("c-stale", [
    message("s1", "user", "first question"),
    message("s2", "assistant", "first answer"),
    message("s3", "user", "second question"),
  ]);
  answer("c-stale", "s4", "second answer", "s3");

  write("c-stale", [
    message("s1", "user", "first question"),
    message("s2", "assistant", "first answer"),
    message("s5", "user", "from the stale tab"),
  ]);

  assert.deepEqual(ids("c-stale"), ["s1", "s2", "s3", "s4", "s5"]);
});

test("a request list that is a prefix of stored history keeps the extra turns", () => {
  write("c-prefix", [message("p1", "user", "one"), message("p2", "assistant", "two")]);
  answer("c-prefix", "p3", "three", "p1");

  write("c-prefix", [message("p1", "user", "one")]);

  assert.deepEqual(ids("c-prefix").sort(), ["p1", "p2", "p3"]);
});

test("a regenerate that never stores a replacement keeps the previous answer", () => {
  write("c-regen", [message("g1", "user", "explain the bug")]);
  answer("c-regen", "g2", "the first answer", "g1");

  write("c-regen", [message("g1", "user", "explain the bug")]);

  assert.deepEqual(ids("c-regen"), ["g1", "g2"]);
});

test("a resent message without parts keeps its stored row", () => {
  write("c-parts", [message("x1", "user", "kept with parts"), message("x2", "assistant", "resent without parts")]);

  write("c-parts", [message("x1", "user", "kept with parts"), { id: "x2", role: "assistant" }]);

  assert.deepEqual(ids("c-parts"), ["x1", "x2"]);
});

test("two interleaved sends keep both rows", () => {
  write("c-concurrent", [message("k1", "user", "from tab A")]);
  write("c-concurrent", [message("k2", "user", "from tab B")]);

  assert.deepEqual(ids("c-concurrent"), ["k1", "k2"]);
});
