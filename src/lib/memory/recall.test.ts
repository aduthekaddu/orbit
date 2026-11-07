import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { startMockOllama } from "./ollama-harness";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-memory-recall-"));
process.env.ORBIT_DATA_DIR = dataDir;
delete process.env.ORBIT_OLLAMA_URL;

type RecallModule = typeof import("./recall");
type StoreModule = typeof import("./store");
type EmbedModule = typeof import("./embed");

let recall: RecallModule | undefined;
let store: StoreModule | undefined;
let embed: EmbedModule | undefined;
let importError = "";
let mock: { url: string; stop: () => Promise<void> } | undefined;

before(async () => {
  try {
    recall = await import("./recall");
    store = await import("./store");
    embed = await import("./embed");
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  if (recall && store && embed) {
    mock = await startMockOllama();
    process.env.ORBIT_OLLAMA_URL = mock.url;
  }
});

after(async () => {
  await mock?.stop();
});

function modules() {
  assert.equal(importError, "", `memory recall is missing: ${importError}`);
  if (!recall || !store || !embed) throw new Error("memory recall is missing");
  return { recall, store, embed };
}

test("fuseRanks puts a row in both lists ahead of a row in one list", () => {
  const { recall } = modules();
  const fused = recall.fuseRanks(["a", "b", "c"], ["b"], 2);
  assert.deepEqual(fused.map((row) => row.id), ["b", "a"]);
  assert.equal(fused[0]?.via, "both");
  assert.equal(fused[1]?.via, "text");
});

test("fuseRanks breaks a score tie by the text rank", () => {
  const { recall } = modules();
  const fused = recall.fuseRanks(["a", "b"], ["b", "a"], 2);
  assert.deepEqual(fused.map((row) => row.id), ["a", "b"]);
  assert.equal(fused[0]?.score, fused[1]?.score);
  assert.equal(fused[0]?.via, "both");
});

test("a vector match finds a memory that shares no words with the question", async () => {
  const { recall, store, embed } = modules();
  const saved = store.saveMemory({ text: "Deploy targets Fly.io", kind: "fact" });
  store.saveMemory({ text: "Bananas prefer purple teacups", kind: "fact" });
  const filled = await embed.embedPending();
  assert.equal(filled.ok, true);
  const hits = await recall.recall("Where should hosting live?", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.memory.id, saved.id);
  assert.equal(hits[0]?.via, "vector");
  assert.ok(hits[0]?.memory.lastUsedAt instanceof Date);
});

test("recall with Ollama down still returns a full text match", async () => {
  const { recall, store, embed } = modules();
  const saved = store.saveMemory({ text: "The zebrarecall token is stored", kind: "preference" });
  assert.equal((await embed.embedPending()).ok, true);
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  try {
    const hits = await recall.recall("zebrarecall", 3);
    assert.equal(hits[0]?.memory.id, saved.id);
    assert.equal(hits[0]?.via, "text");
    const semantic = await recall.recall("Where should hosting live?", 3);
    assert.equal(semantic.some((hit) => hit.memory.text === "Deploy targets Fly.io"), false);
  } finally {
    if (mock) process.env.ORBIT_OLLAMA_URL = mock.url;
  }
});

test("a full question finds the memory that shares one word when Ollama is down", async () => {
  const { recall, store } = modules();
  const deploy = store.saveMemory({ text: "I deploy everything to Fly.io", kind: "fact" });
  store.saveMemory({ text: "My favorite language is Go", kind: "preference" });
  store.saveMemory({ text: "I prefer dark mode in every editor", kind: "preference" });
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  try {
    const hits = await recall.recall("Where do I deploy things?", 3);
    assert.equal(hits[0]?.memory.id, deploy.id);
    assert.equal(hits[0]?.via, "text");
  } finally {
    if (mock) process.env.ORBIT_OLLAMA_URL = mock.url;
  }
});

test("the instruction block keeps three memories and says to use them only when relevant", () => {
  const { recall } = modules();
  const block = recall.recalledInstructions([
    { id: "mem-one", text: "one fact" },
    { id: "mem-two", text: "two fact" },
    { id: "mem-three", text: "three fact" },
    { id: "mem-four", text: "four fact" },
  ]);
  assert.match(block, /Use them only when relevant/);
  assert.match(block, /mem-one one fact/);
  assert.match(block, /mem-three three fact/);
  assert.doesNotMatch(block, /four fact/);
  assert.equal(recall.recalledInstructions([]), "");
});

test("the prompt tells the model to remember a lasting fact or preference", () => {
  const { recall } = modules();
  assert.match(recall.REMEMBER_INSTRUCTIONS, /lasting fact or preference/);
  assert.match(recall.REMEMBER_INSTRUCTIONS, /remember something/);
});
