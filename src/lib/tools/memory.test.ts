import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Redactor } from "../chat-errors";
import { getDb } from "../db";
import { user } from "../db/schema";
import { parseViewer } from "../policy";
import * as store from "../memory/store";
import { toolsFor } from "./index";
import * as tools from "./memory";

delete process.env.ORBIT_OLLAMA_URL;

const viewer = parseViewer({ id: "memory-admin", role: "admin" });
const member = parseViewer({ id: "memory-member", role: "member" });

before(() => {
  getDb().insert(user).values([
    { ...viewer, name: "Admin", email: "memory-admin@orbit.test" },
    { ...member, name: "Member", email: "memory-member@orbit.test" },
  ]).run();
});

after(() => {
  getDb().$client.close();
});

test("forget refuses a call that has no id and leaves the memory in place", () => {
  const saved = store.saveMemory(viewer.id, { text: "Keep the forgetgate token", kind: "fact", source: "tool" });
  assert.deepEqual(tools.forgetMemory(viewer.id, ""), { error: "Memory id is required" });
  assert.deepEqual(tools.forgetMemory(viewer.id, "   "), { error: "Memory id is required" });
  assert.equal(store.getMemory(viewer.id, saved.id)?.text, "Keep the forgetgate token");
  assert.equal(tools.forgetIdSchema.safeParse({}).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: "" }).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: "   " }).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: saved.id }).success, true);
});

test("remember returns the saved text", () => {
  const saved = tools.rememberFact(viewer.id, { chatId: null, messageId: null }, { text: "I deploy to Fly.io", kind: "fact" });
  assert.deepEqual(saved, { id: "id" in saved ? saved.id : "", text: "I deploy to Fly.io" });
});

test("remember masks stored credentials before saving to SQLite and returning tool output", async () => {
  const providerKey = "made-up-provider-key-0001";
  const tavilyKey = "made-up-tavily-key-0002";
  const settings = { searxngUrl: "", tavilyApiKey: tavilyKey, githubToken: "", githubMcpUrl: "" };
  const tool = toolsFor({
    instance: { ...settings, sandbox: "on" },
    user: { id: viewer.id, memory: true, github: settings },
  }, undefined, undefined, new Redactor(settings, { apiKey: providerKey, baseUrl: "http://127.0.0.1:9/v1" })).remember;
  assert.ok(tool?.execute);
  const result = (await tool.execute(
    { text: `Use ${providerKey} and made%2Dup-tavily-key-0002`, kind: "fact" },
    { toolCallId: "rem-1", messages: [], context: {} },
  )) as { id?: string; text?: string };
  assert.ok(result.id);
  assert.equal(result.text, "Use [redacted] and [redacted]");
  assert.equal(store.getMemory(viewer.id, result.id)?.text, "Use [redacted] and [redacted]");
});

test("forget cannot delete a note owned by another account", () => {
  const saved = store.saveMemory(viewer.id, { text: "Private forget canary", kind: "fact", source: "tool" });
  assert.deepEqual(tools.forgetMemory(member.id, saved.id), { error: "No memory with that id" });
  assert.deepEqual(store.getMemory(viewer.id, saved.id), saved);
});

test("memory tools follow the current account's preference", () => {
  const instance = { searxngUrl: "", tavilyApiKey: "", sandbox: "on" as const };
  const github = { githubToken: "", githubMcpUrl: "" };
  const disabled = toolsFor({ instance, user: { id: member.id, memory: false, github } });
  assert.equal("remember" in disabled, false);
  assert.equal("forget" in disabled, false);
  const enabled = toolsFor({ instance, user: { id: viewer.id, memory: true, github } });
  assert.equal("remember" in enabled, true);
  assert.equal("forget" in enabled, true);
});
