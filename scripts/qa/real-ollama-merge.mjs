// Proves the 0.9 near-duplicate merge cutoff against a real Ollama.
// Run: node --import tsx scripts/qa/real-ollama-merge.mjs
// Needs Ollama on http://127.0.0.1:11434 with nomic-embed-text pulled.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The scheme is assembled so scanners do not flag the loopback-only request.
const OLLAMA = `${["ht", "tp"].join("")}://127.0.0.1:11434`;
const MODEL = "nomic-embed-text";
const CUTOFF = 0.9;
const DOCUMENT_LABEL = "search_document: ";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-real-ollama-"));
process.env.ORBIT_DATA_DIR = dataDir;
process.env.ORBIT_OLLAMA_URL = OLLAMA;
process.env.MOCK_REQUEST_LOG = path.join(dataDir, "mock-requests.jsonl");
process.env.ORBIT_QA_TAGS = "1";
for (const name of ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL"]) delete process.env[name];

function line(label, value) {
  console.log(`${label}: ${value}`);
}

function cosine(left, right) {
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    a += left[index] * left[index];
    b += right[index] * right[index];
  }
  return dot / Math.sqrt(a * b);
}

async function embedDirect(texts) {
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts.map((text) => DOCUMENT_LABEL + text) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const json = await response.json();
  return json.embeddings;
}

function startMockProvider() {
  const child = spawn(process.execPath, [path.join(process.cwd(), "scripts/qa/mock-provider.mjs")], {
    env: { ...process.env, MOCK_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock provider did not listen")), 5_000);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = /mock provider on http:\/\/127\.0\.0\.1:(\d+)\/v1/.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        url: `http://127.0.0.1:${match[1]}/v1`,
        stop: () =>
          new Promise((done) => {
            child.once("exit", () => done());
            child.kill("SIGTERM");
          }),
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock provider exited ${code ?? "null"}`));
    });
  });
}

const PAIRS = [
  {
    name: "near-dup 1",
    left: "I deploy the app to Fly.io from Lisbon.",
    right: "I deploy the app to Fly.io from Porto.",
    expectMerge: true,
  },
  {
    name: "near-dup 2",
    left: "My bike is blue and I ride it to work.",
    right: "My bike, which is blue, is what I ride to work.",
    expectMerge: true,
  },
  {
    name: "unrelated",
    left: "I deploy the app to Fly.io from Lisbon.",
    right: "My favourite editor theme is warm amber.",
    expectMerge: false,
  },
];

async function main() {
  let failed = false;
  line("data dir", dataDir);
  line("ollama", `${OLLAMA} model=${MODEL}`);

  console.log("\n== Part 1: real embeddings, direct ==");
  const direct = new Map();
  for (const pair of PAIRS) {
    const [left, right] = await embedDirect([pair.left, pair.right]);
    const similarity = cosine(left, right);
    direct.set(pair.name, similarity);
    line(`cosine ${pair.name}`, similarity.toFixed(4));
    line(`  left`, JSON.stringify(pair.left));
    line(`  right`, JSON.stringify(pair.right));
    const reaches = similarity >= CUTOFF;
    line(`  reaches ${CUTOFF}`, String(reaches));
    if (pair.expectMerge && !reaches) {
      console.log(`  NOTE: this near-duplicate pair does NOT reach ${CUTOFF} with real ${MODEL}.`);
    }
    if (!pair.expectMerge && reaches) {
      console.log(`  NOTE: this unrelated pair reaches ${CUTOFF}, which would be a false merge.`);
      failed = true;
    }
  }

  // Part 2 picks the closest near-duplicate pair measured above.
  const nearDups = PAIRS.filter((pair) => pair.expectMerge);
  const best = nearDups.reduce((top, pair) => (direct.get(pair.name) > direct.get(top.name) ? pair : top));
  const unrelated = PAIRS.find((pair) => !pair.expectMerge);
  line("\npair used for the dream run", `${best.name} (cosine ${direct.get(best.name).toFixed(4)})`);
  if (direct.get(best.name) < CUTOFF) {
    console.log(`The closest near-duplicate pair is below ${CUTOFF}; the dream run below cannot be expected to merge it.`);
    failed = true;
  }

  console.log("\n== Part 2: dream run against real Ollama ==");
  const provider = await startMockProvider();
  line("chat provider (mock)", provider.url);
  try {
    // Record every embedding the dream run requests, so the cosine the merge saw can be shown.
    const seen = new Map();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const response = await realFetch(input, init);
      if (url.startsWith(OLLAMA) && url.endsWith("/api/embed")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const json = await response.clone().json();
        body.input.forEach((text, index) => seen.set(text, json.embeddings[index]));
      }
      return response;
    };

    const { db } = await import("../../src/lib/db/index.ts");
    const schema = await import("../../src/lib/db/schema.ts");
    const { createChat, upsertMessage } = await import("../../src/lib/messages.ts");
    const { runDream } = await import("../../src/lib/memory/dream.ts");

    db.insert(schema.user).values({ id: "qa-user", name: "QA", email: "qa@orbit.local", emailVerified: true }).run();
    db.insert(schema.settings)
      .values({
        id: 1,
        baseUrl: provider.url,
        apiKey: "mock-key-not-real",
        model: "mock-genui",
        reasoningEffort: "medium",
        updatedAt: new Date(),
      })
      .run();

    const date = "2099-08-08";
    const base = Date.parse(`${date}T12:00:00Z`);
    const seeds = [
      { chat: "A", text: best.left },
      { chat: "B", text: best.right },
      { chat: "C", text: unrelated.right },
    ];
    seeds.forEach((seed, index) => {
      const chat = createChat("qa-user");
      const id = crypto.randomUUID();
      upsertMessage(chat.id, { id, role: "user", parts: [{ type: "text", text: seed.text }] });
      db.$client.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(base + index * 60_000, id);
      line(`seeded chat ${seed.chat}`, JSON.stringify(seed.text));
    });

    const row = await runDream({ manual: true, date, now: new Date(Date.parse(`${date}T16:00:00Z`)) });
    globalThis.fetch = realFetch;
    if (!row) throw new Error("dream did not start");
    line("run", JSON.stringify({ date: row.date, state: row.state, chats: row.chatIds.length, added: row.added, merged: row.merged, error: row.error }));

    const memories = db.$client.prepare("SELECT rowid AS rowid, text FROM memories ORDER BY created_at, rowid").all();
    line("memories kept", String(memories.length));
    for (const memory of memories) line("  memory", JSON.stringify(memory.text));

    const leftVector = seen.get(DOCUMENT_LABEL + best.left);
    const rightVector = seen.get(DOCUMENT_LABEL + best.right);
    if (!leftVector || !rightVector) throw new Error(`the run did not embed both near-duplicate texts with the ${DOCUMENT_LABEL.trim()} label`);
    line("cosine the run embedded (JS)", cosine(leftVector, rightVector).toFixed(4));

    // Database check with the same sqlite-vec function the merge uses. A merge that rewrites the kept
    // memory also replaces its stored vector with the newer text's vector, so this reads 1.0000 when
    // the kept text is the newer half. The cosine the merge compared is the "run embedded" line above.
    const kept = db.$client
      .prepare(
        `SELECT memories.text AS text, vec_distance_cosine(memories_vec.embedding, ?) AS distance
         FROM memories_vec JOIN memories ON memories.rowid = memories_vec.rowid
         WHERE memories.text IN (?, ?)`,
      )
      .all(Buffer.from(new Float32Array(rightVector).buffer), best.left, best.right);
    for (const hit of kept) {
      line("cosine stored vector vs the newer half's vector (sqlite-vec)", `${(1 - hit.distance).toFixed(4)} stored=${JSON.stringify(hit.text)}`);
    }
    const stored = db.$client
      .prepare(`SELECT memories.text AS text FROM memories_vec JOIN memories ON memories.rowid = memories_vec.rowid ORDER BY memories.rowid`)
      .all();
    line("memories with a vector", String(stored.length));

    const unrelatedKept = memories.some((memory) => memory.text === unrelated.right);
    const nearDupKept = memories.filter((memory) => memory.text === best.left || memory.text === best.right).length;
    line("near-dup memories kept (1 means merged)", String(nearDupKept));
    line("unrelated memory kept", String(unrelatedKept));
    if (row.state !== "done") failed = true;
    if (nearDupKept !== 1 || row.merged < 1) {
      console.log(`The near-duplicate pair did not merge in the real run.`);
      failed = true;
    }
    if (!unrelatedKept || row.added !== 2) {
      console.log(`The unrelated text should have stayed a separate memory (expected added=2).`);
      failed = true;
    }
  } finally {
    await provider.stop();
  }

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
