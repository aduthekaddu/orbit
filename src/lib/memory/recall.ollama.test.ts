import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { FLY_PAIR, MAIN, type LabeledSet } from "./ollama-pairs";

type EmbedModule = typeof import("./embed");
type StoreModule = typeof import("./store");

let embed: EmbedModule | undefined;
let store: StoreModule | undefined;
let unavailable = "";
const memoryIds = new Map<string, string>();

before(async () => {
  embed = await import("./embed");
  store = await import("./store");
  const probe = await embed.embed(["orbit"], "query");
  if (!probe.ok) {
    unavailable = `real Ollama with ${embed.EMBED_MODEL} is not available: ${probe.error}`;
    return;
  }
  for (const topic of MAIN.topics) {
    for (const text of topic.memories) memoryIds.set(text, store.saveMemory({ text, kind: "fact" }).id);
  }
  const filled = await embed.embedPending();
  assert.equal(filled.ok, true, filled.ok ? undefined : `every labeled memory must embed: ${filled.error}`);
});

// The recall tests check ranking quality, not latency. The product's one-second query deadline is
// shorter than a loaded host's or CI runner's real Ollama answer time (#103), so this file waits longer.
const RECALL_EMBED_TIMEOUT_MS = 5_000;

async function nearIds(question: string): Promise<string[]> {
  assert.ok(embed && store);
  const embedded = await embed.embedQuery(question, RECALL_EMBED_TIMEOUT_MS);
  assert.equal(embedded.ok, true, embedded.ok ? undefined : `embed "${question}": ${embedded.error}`);
  if (!embedded.ok || !embedded.vectors[0]) return [];
  return store.vectorMatchIds(embedded.vectors[0], 50);
}

function idsOf(texts: string[]): string[] {
  return texts.map((text) => {
    const id = memoryIds.get(text);
    assert.ok(id, `memory "${text}" was saved`);
    return id;
  });
}

async function missedRelated(set: LabeledSet): Promise<string[]> {
  const missed: string[] = [];
  for (const topic of set.topics) {
    const wanted = idsOf(topic.memories);
    for (const question of topic.questions) {
      const near = await nearIds(question);
      for (const [index, id] of wanted.entries()) {
        if (!near.includes(id)) missed.push(`"${question}" misses "${topic.memories[index]}"`);
      }
    }
  }
  return missed;
}

async function leakedUnrelated(set: LabeledSet): Promise<string[]> {
  const leaked: string[] = [];
  const textOf = new Map([...memoryIds.entries()].map(([text, id]) => [id, text]));
  for (const question of set.unrelated) {
    for (const id of await nearIds(question)) leaked.push(`"${question}" reaches "${textOf.get(id)}"`);
  }
  return leaked;
}

test("a question with no shared word finds the Fly.io memory by vector", async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  const [wanted] = idsOf([FLY_PAIR.memory]);
  assert.ok(wanted);
  assert.ok((await nearIds(FLY_PAIR.question)).includes(wanted), `"${FLY_PAIR.question}" must reach "${FLY_PAIR.memory}"`);
});

test("every related question reaches the memories it is about", async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(await missedRelated(MAIN), []);
});

test("an unrelated question reaches no memory", async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(await leakedUnrelated(MAIN), []);
});
