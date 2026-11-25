import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { startMockOllama } from "./ollama-harness";

delete process.env.ORBIT_OLLAMA_URL;

type EmbedModule = typeof import("./embed");
type StoreModule = typeof import("./store");

let embed: EmbedModule | undefined;
let store: StoreModule | undefined;
let importError = "";
let mock: { url: string; stop: () => Promise<void> } | undefined;

before(async () => {
  try {
    embed = await import("./embed");
    store = await import("./store");
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  if (embed && store) mock = await startMockOllama();
});

after(async () => {
  await mock?.stop();
});

function modules() {
  assert.equal(importError, "", `memory embed is missing: ${importError}`);
  if (!embed || !store || !mock) throw new Error("memory embed is missing");
  return { embed, store, mock };
}

test("embed reads 768 numbers from Ollama", async () => {
  const { embed, mock } = modules();
  process.env.ORBIT_OLLAMA_URL = mock.url;
  const result = await embed.embed(["Deploy targets Fly.io", "Where should hosting live?"], "document");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.vectors.length, 2);
  assert.equal(result.vectors[0]?.length, 768);
  assert.equal(result.vectors[1]?.length, 768);
});

test("embed rejects a vector of the wrong length", async () => {
  const { embed, mock } = modules();
  await fetch(`${mock.url}/qa/short`, { method: "POST" });
  process.env.ORBIT_OLLAMA_URL = mock.url;
  try {
    const result = await embed.embed(["too short"], "document");
    assert.equal(result.ok, false);
  } finally {
    await fetch(`${mock.url}/qa/ok`, { method: "POST" });
  }
});

test("embed reports that Ollama is unreachable", async () => {
  const { embed } = modules();
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  const result = await embed.embed(["hello"], "document");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Ollama/);
});

test("embed gives up after 5 seconds when Ollama accepts and never answers", async () => {
  const { embed } = modules();
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.env.ORBIT_OLLAMA_URL = `http://127.0.0.1:${port}`;
  const started = Date.now();
  try {
    const result = await embed.embed(["hang"], "document");
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.ok(elapsed >= 4_500 && elapsed < 8_000, `elapsed ${elapsed}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a hung Ollama does not stall a second status check", async () => {
  const { embed, store } = modules();
  const saved = store.saveMemory({ text: "Hangsearch token stays searchable", kind: "fact", source: "tool" });
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.env.ORBIT_OLLAMA_URL = `http://127.0.0.1:${port}`;
  const started = Date.now();
  try {
    const [first, second] = await Promise.all([embed.memoryEmbeddings(), embed.memoryEmbeddings()]);
    const elapsed = Date.now() - started;
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.ok(elapsed < 2_000, `elapsed ${elapsed}`);
    const again = Date.now();
    const third = await embed.memoryEmbeddings();
    assert.equal(third.ok, false);
    assert.ok(Date.now() - again < 200, `cached ${Date.now() - again}`);
    assert.equal(store.listMemories("Hangsearch").some((memory) => memory.id === saved.id), true);
    assert.equal(store.getMemory(saved.id)?.embedded, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("embedPending fills vectors after Ollama comes back", async () => {
  const { embed, store, mock } = modules();
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  const saved = store.saveMemory({ text: "Pending embedtoken until Ollama returns", kind: "fact", source: "tool" });
  assert.equal(store.getMemory(saved.id)?.embedded, false);
  const failed = await embed.embedPending();
  assert.equal(failed.ok, false);
  assert.equal(store.getMemory(saved.id)?.embedded, false);
  process.env.ORBIT_OLLAMA_URL = mock.url;
  const filled = await embed.embedPending();
  assert.equal(filled.ok, true);
  if (filled.ok) assert.ok(filled.embedded >= 1);
  assert.equal(store.getMemory(saved.id)?.embedded, true);
});

test("questions reach Ollama as search_query and saved memories as search_document", async () => {
  const { embed, store, mock } = modules();
  process.env.ORBIT_OLLAMA_URL = mock.url;
  const question = "Prefixcheck where do these notes live?";
  const memoryText = "Prefixcheck notes live in a shoebox";
  store.saveMemory({ text: memoryText, kind: "fact", source: "tool" });
  assert.equal((await embed.embedQuery(question)).ok, true);
  assert.equal((await embed.embedPending()).ok, true);
  const received = (await (await fetch(`${mock.url}/qa/received`)).json()) as string[];
  assert.ok(received.includes(`search_query: ${question}`), "the question goes out as search_query");
  assert.ok(received.includes(`search_document: ${memoryText}`), "the saved memory goes out as search_document");
  assert.equal(received.includes(question), false);
  assert.equal(received.includes(memoryText), false);
});
