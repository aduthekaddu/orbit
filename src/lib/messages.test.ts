import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

type Modules = {
  db: typeof import("./db").db;
  schema: typeof import("./db/schema");
  persistIncoming: typeof import("./messages").persistIncoming;
  listMessages: typeof import("./messages").listMessages;
  upsertMessage: typeof import("./messages").upsertMessage;
};

let mods: Modules;

before(async () => {
  const repo = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-messages-"));
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
    listMessages: messageModule.listMessages,
    upsertMessage: messageModule.upsertMessage,
  };

  const now = new Date();
  mods.db.insert(mods.schema.user).values({ id: "u1", name: "Test", email: "test@orbit.local" }).run();
  mods.db.insert(mods.schema.chats).values({ id: "c1", userId: "u1", title: "One", createdAt: now, updatedAt: now }).run();
  mods.db.insert(mods.schema.chats).values({ id: "c2", userId: "u1", title: "Two", createdAt: now, updatedAt: now }).run();
});

function changes() {
  return (mods.db.$client.prepare("select total_changes() as n").get() as { n: number }).n;
}

function message(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text", text }] };
}

test("resending a full history writes nothing", () => {
  const history = [
    message("m1", "user", "one"),
    message("m2", "assistant", "two"),
    message("m3", "user", "three"),
  ];
  assert.equal(mods.persistIncoming("c1", history), true);
  const before = changes();
  assert.equal(mods.persistIncoming("c1", history), true);
  assert.equal(changes() - before, 0);
});

test("a new message is written once", () => {
  const history = [message("m1", "user", "one"), message("m4", "user", "four")];
  const before = changes();
  assert.equal(mods.persistIncoming("c1", history), true);
  assert.equal(changes() - before, 1);
});

test("a message id from another chat is rejected", () => {
  mods.db
    .insert(mods.schema.messages)
    .values({ id: "m9", chatId: "c2", role: "user", content: "x", parts: "[]", position: 0, createdAt: new Date() })
    .run();
  assert.equal(mods.persistIncoming("c1", [message("m9", "user", "x")]), false);
});

test("a reply keeps its prompt's place when two requests finish out of order", () => {
  const now = new Date();
  mods.db.insert(mods.schema.chats).values({ id: "c3", userId: "u1", title: "Three", createdAt: now, updatedAt: now }).run();
  assert.equal(mods.persistIncoming("c3", [message("p-a", "user", "prompt a")]), true);
  assert.equal(
    mods.persistIncoming("c3", [message("p-a", "user", "prompt a"), message("p-b", "user", "prompt b")]),
    true,
  );

  assert.equal(mods.upsertMessage("c3", message("r-b", "assistant", "reply b"), "p-b"), true);
  assert.equal(mods.upsertMessage("c3", message("r-a", "assistant", "reply a"), "p-a"), true);

  assert.deepEqual(
    mods.listMessages("c3").map((entry) => entry.id),
    ["p-a", "r-a", "p-b", "r-b"],
  );
});
