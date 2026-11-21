import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-bench-search-"));
process.env.ORBIT_DATA_DIR = dataDir;

async function main() {
const { db } = await import("../src/lib/db/index");
const schema = await import("../src/lib/db/schema");
const { searchMessages } = await import("../src/lib/search");

const now = new Date();
db.insert(schema.user).values({ id: "bench", name: "Bench", email: "bench@orbit.local" }).run();
db.insert(schema.chats).values({
  id: "bench-chat",
  userId: "bench",
  title: "Bench",
  createdAt: now,
  updatedAt: now,
}).run();

const insert = db.$client.prepare(
  "insert into messages (id, chat_id, parent_id, role, content, parts, position, created_at) values (?, 'bench-chat', null, 'user', ?, '[]', ?, ?)",
);
const stamp = Date.now();
db.$client.exec("begin");
try {
  for (let i = 0; i < 10_000; i += 1) {
    insert.run(`m${i}`, `note token${i % 200} item ${i}`, i, stamp + i);
  }
  db.$client.exec("commit");
} catch (error) {
  db.$client.exec("rollback");
  throw error;
}

const stored = db.$client.prepare("select count(*) as n from messages").get() as { n: number };
const times: number[] = [];
let errors = 0;
let hits = 0;
for (let i = 0; i < 100; i += 1) {
  const started = performance.now();
  try {
    hits += searchMessages("bench", `token${i % 200}`).length;
  } catch {
    errors += 1;
  }
  times.push(performance.now() - started);
}
times.sort((left, right) => left - right);
const p50 = times[Math.floor(0.5 * (times.length - 1))] ?? 0;
const p95 = times[Math.ceil(0.95 * times.length) - 1] ?? 0;

console.log(`messages ${stored.n}`);
console.log(`queries ${times.length}`);
console.log(`errors ${errors}`);
console.log(`hits ${hits}`);
console.log(`p50 ${p50.toFixed(3)} ms`);
console.log(`p95 ${p95.toFixed(3)} ms`);

const origin = process.env.ORBIT_BENCH_ORIGIN;
const cookie = process.env.ORBIT_BENCH_COOKIE;
if (!origin || !cookie) {
  console.log("send skipped");
} else {
  const chat = await fetch(`${origin}/api/chats`, { method: "POST", headers: { cookie } });
  if (!chat.ok) {
    console.log(`send errors 1`);
    console.log("send skipped");
    process.exitCode = 1;
  } else {
    const { id } = (await chat.json()) as { id: string };
    const started = performance.now();
    const response = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        id,
        messages: [{ id: "bench-user", role: "user", parts: [{ type: "text", text: "[qa:plain] ping" }] }],
        trigger: "submit-message",
      }),
    });
    const reader = response.body?.getReader();
    const first = reader ? await reader.read() : { done: true };
    const elapsed = performance.now() - started;
    await reader?.cancel().catch(() => {});
    console.log(`send status ${response.status}`);
    console.log(`send errors ${response.ok && !first.done ? 0 : 1}`);
    console.log(`send first byte ${elapsed.toFixed(3)} ms`);
  }
}
}

main();
