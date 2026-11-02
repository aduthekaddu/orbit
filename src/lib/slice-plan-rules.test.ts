import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const repo = process.cwd();

function plan(name: string) {
  return fs.readFileSync(path.join(repo, "docs/slices", name), "utf8");
}

function section(md: string, heading: string, next: string) {
  return md.split(heading)[1]?.split(next)[0] ?? "";
}

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 2, 6, 0, 0);

type RunRow = {
  state: string;
  startedAt: number;
  leaseUntil: number;
  owner: string;
};

function claimWhere(md: string) {
  const match = md.match(/ON CONFLICT DO UPDATE … WHERE ([^`\n]+)/);
  if (!match) throw new Error("claim predicate missing");
  return match[1];
}

function claim(where: string, row: RunRow, owner: string) {
  const db = new Database(":memory:");
  db.exec(`
    create table memory_runs (
      date text primary key,
      state text not null,
      started_at integer not null,
      lease_until integer,
      owner text
    )
  `);
  db.prepare("insert into memory_runs (date, state, started_at, lease_until, owner) values (?, ?, ?, ?, ?)").run(
    "2026-11-02",
    row.state,
    row.startedAt,
    row.leaseUntil,
    row.owner,
  );
  db.prepare(
    `insert into memory_runs (date, state, started_at, lease_until, owner)
     values (@date, 'running', @now, @lease, @owner)
     on conflict(date) do update set state = 'running', started_at = @now, lease_until = @lease, owner = @owner
     where ${where}`,
  ).run({ date: "2026-11-02", now, lease: now + 2 * 60 * 1000, owner, stale: now - 2 * HOUR });
  return db.prepare("select state, owner from memory_runs where date = ?").get("2026-11-02") as { state: string; owner: string };
}

function renewSql(md: string) {
  const match = md.match(/UPDATE memory_runs SET lease_until = :next WHERE [^`\n]+/);
  return match ? match[0] : "UPDATE memory_runs SET lease_until = :next WHERE date = :date";
}

function renew(sql: string, writer: string) {
  const db = new Database(":memory:");
  db.exec("create table memory_runs (date text primary key, lease_until integer, owner text)");
  db.prepare("insert into memory_runs (date, lease_until, owner) values ('2026-11-02', 1, 'worker-a')").run();
  return db.prepare(sql).run({ next: 2, date: "2026-11-02", owner: writer }).changes;
}

test("a finished dream run stays finished when its start time is stale", () => {
  const row = claim(claimWhere(plan("11.md")), { state: "done", startedAt: now - 3 * HOUR, leaseUntil: now - HOUR, owner: "worker-a" }, "worker-b");
  assert.deepEqual(row, { state: "done", owner: "worker-a" });
});

test("a failed dream run waits for a manual rerun", () => {
  const row = claim(claimWhere(plan("11.md")), { state: "failed", startedAt: now - 3 * HOUR, leaseUntil: now - HOUR, owner: "worker-a" }, "worker-b");
  assert.equal(row.state, "failed");
});

test("a live dream worker keeps the night after two hours", () => {
  const row = claim(
    claimWhere(plan("11.md")),
    { state: "running", startedAt: now - 3 * HOUR, leaseUntil: now + HOUR, owner: "worker-a" },
    "worker-b",
  );
  assert.equal(row.owner, "worker-a");
});

test("an expired dream lease can be claimed", () => {
  const row = claim(
    claimWhere(plan("11.md")),
    { state: "running", startedAt: now - 3 * HOUR, leaseUntil: now - HOUR, owner: "worker-a" },
    "worker-b",
  );
  assert.equal(row.owner, "worker-b");
});

test("a dream worker that lost the lease does not write", () => {
  const sql = renewSql(plan("11.md"));
  assert.equal(renew(sql, "worker-a"), 1);
  assert.equal(renew(sql, "worker-b"), 0);
});

test("a failed dream chat finishes the night and is retried on the next one", () => {
  const md = plan("11.md");
  const recordsRetry = md.includes("appended to `retryChatIds`");
  const doneAllowsRetry = md.includes("in `doneChatIds` or `retryChatIds`");
  const carriesRetry = md.includes("plus any `retryChatIds`");
  const chatIds = ["a", "b"];
  const doneChatIds = ["b"];
  const retryChatIds = recordsRetry ? ["a"] : [];
  const settled = chatIds.every((id) => doneChatIds.includes(id) || (doneAllowsRetry && retryChatIds.includes(id)));
  const nextChatIds = carriesRetry ? ["c", ...retryChatIds] : ["c"];
  assert.deepEqual(
    { state: settled ? "done" : "running", nextChatIds },
    { state: "done", nextChatIds: ["c", "a"] },
  );
});

function sdkDefaultMaxRetries() {
  const sdk = fs.readFileSync(path.join(repo, "node_modules/ai/dist/index.js"), "utf8");
  const match = sdk.match(/defaultMaxRetries = (\d+)/);
  if (!match) throw new Error("AI SDK default maxRetries missing");
  return Number(match[1]);
}

function routeMaxRetries() {
  const route = fs.readFileSync(path.join(repo, "src/app/api/chat/route.ts"), "utf8");
  const call = route.slice(route.indexOf("streamText("), route.indexOf("toUIMessageStream"));
  const match = call.match(/maxRetries:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function failFirstCount(md: string) {
  const match = md.match(/returns HTTP 500 for the first (\d+) requests/);
  if (match) return Number(match[1]);
  if (md.includes("answers the first request for a given prompt with HTTP 500")) return 1;
  throw new Error("fail-first rule missing");
}

function firstSendShowsError(failures: number, maxRetries: number) {
  const attempts = 1 + maxRetries;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt >= failures) return false;
  }
  return true;
}

test("the first fail-first send stays failed through the SDK retries", () => {
  const maxRetries = routeMaxRetries() ?? sdkDefaultMaxRetries();
  const failures = failFirstCount(plan("03.md"));
  const showed = firstSendShowsError(failures, maxRetries);
  assert.equal(showed, true, `a ${failures}-failure mock with maxRetries ${maxRetries} hides the error`);
});

test("the fail-first retry streams slowly enough to stop", () => {
  const md = plan("03.md");
  const paragraph = md.slice(md.indexOf("[qa:fail-first]"), md.indexOf("[qa:slow]"));
  assert.equal(paragraph.includes("streams one word every 200 ms"), true);
});

test("a saved prompt with no reply becomes the branch head", () => {
  const md = plan("04.md");
  const afterUser = md.includes("sets `chats.head_id` to that user message") ? "user" : "previous";
  const afterReply = md.includes("to that reply") || md.includes("to the reply") ? "reply" : afterUser;
  assert.deepEqual({ afterUser, afterReply }, { afterUser: "user", afterReply: "reply" });
});

type TreeMessage = { id: string; parentId: string | null };

function visibleIds(messages: TreeMessage[], headId: string) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const ids: string[] = [];
  let current: string | null = headId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    ids.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return ids;
}

test("search opens the branch that contains the hit before scrolling", () => {
  const messages: TreeMessage[] = [
    { id: "u1", parentId: null },
    { id: "a1", parentId: "u1" },
    { id: "a2", parentId: "u1" },
  ];
  const md = plan("06.md");
  const visible = visibleIds(messages, "a1");
  const target = visible.includes("a2") || md.includes("loads that message's path before it scrolls") ? "a2" : null;
  assert.equal(target, "a2");
});

type ToolPart = { state: string; ok?: boolean; errorText?: string };

function statusRows(md: string) {
  const lines = md.split("\n");
  const header = lines.findIndex((line) => line.startsWith("|") && line.includes("Run status"));
  if (header < 0) throw new Error("run status table missing");
  const rows: { condition: string; status: string }[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells[0].startsWith("---")) continue;
    rows.push({ condition: cells[0], status: cells[1].replaceAll("`", "") });
  }
  return rows;
}

function conditionMatches(condition: string, part: ToolPart) {
  const states = ["input-streaming", "input-available", "output-available", "output-error"].filter((state) => condition.includes(state));
  if (states.length > 0 && !states.includes(part.state)) return false;
  if (condition.includes("ok: false") && part.ok !== false) return false;
  if (condition.includes("ok: true") && part.ok !== true) return false;
  if (condition.includes("Stopped") && part.errorText !== "Stopped") return false;
  if (condition.includes("otherwise") && part.errorText === "Stopped") return false;
  if (condition.includes("stopped before output")) return part.state === "input-streaming" || part.state === "input-available";
  return states.length > 0 || condition.includes("ok:") || condition.includes("Stopped") || condition.includes("otherwise");
}

function runStatus(md: string, part: ToolPart) {
  const matches = statusRows(md).filter((row) => conditionMatches(row.condition, part));
  if (matches.length === 0) throw new Error(`no status row for ${part.state}`);
  const ranked = [...matches].sort((left, right) => specificity(right.condition) - specificity(left.condition));
  return ranked[0].status;
}

function specificity(condition: string) {
  let score = 0;
  if (condition.includes("ok: false") || condition.includes("ok: true")) score += 2;
  if (condition.includes("Stopped")) score += 2;
  if (condition.includes("otherwise")) score += 1;
  return score;
}

test("a search result with ok false is a failed run", () => {
  assert.equal(runStatus(plan("07.md"), { state: "output-available", ok: false }), "failed");
});

test("a stopped tool part stays cancelled after it is stored", () => {
  assert.equal(runStatus(plan("07.md"), { state: "output-error", errorText: "Stopped" }), "cancelled");
});

function ftsDatabase(rebuild: boolean) {
  const db = new Database(":memory:");
  db.exec(`
    create table messages (rowid integer primary key, content text);
    insert into messages(content) values ('zebracorn');
    create virtual table messages_fts using fts5(content, content='messages', content_rowid='rowid');
  `);
  if (rebuild) db.exec("insert into messages_fts(messages_fts) values ('rebuild')");
  return db;
}

function indexProofPasses(md: string, db: Database.Database, token: string) {
  const turn2 = section(md, "### Turn 2", "### Turn 3");
  if (turn2.includes("Search `messages_fts` for a word")) {
    const hit = db.prepare("select count(*) as c from messages_fts where messages_fts match ?").get(token) as { c: number };
    return hit.c === 1;
  }
  const messages = db.prepare("select count(*) as c from messages").get() as { c: number };
  const indexed = db.prepare("select count(*) as c from messages_fts").get() as { c: number };
  return messages.c === indexed.c;
}

test("the search index proof rejects an empty external-content index", () => {
  const md = plan("06.md");
  assert.equal(indexProofPasses(md, ftsDatabase(false), "zebracorn"), false);
  assert.equal(indexProofPasses(md, ftsDatabase(true), "zebracorn"), true);
});

test("the deploy proof signs in on the local origin", () => {
  const setup = fs.readFileSync(path.join(repo, "src/app/api/setup/route.ts"), "utf8");
  assert.equal(setup.includes("session"), false);
  const turn1 = section(plan("12.md"), "### Turn 1", "### Turn 2");
  const signsIn = turn1.includes("sign in at `http://127.0.0.1:3210`") && turn1.includes("a protected page");
  assert.equal(signsIn, true);
});

test("the branch backfill proof allows a chat with no messages", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-plan-"));
  const cwd = process.cwd();
  fs.mkdirSync(path.join(sandbox, "data"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);
  try {
    const { db } = await import("./db");
    const schema = await import("./db/schema");
    const { createChat, listMessages, upsertMessage } = await import("./messages");
    db.insert(schema.user).values({ id: "u1", name: "Test", email: "plan@orbit.local" }).run();
    const empty = createChat("u1");
    const full = createChat("u1");
    upsertMessage(full.id, { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] });
    const chats = 2;
    const nonempty = [empty.id, full.id].filter((id) => listMessages(id).length > 0).length;
    const roots = nonempty;
    const turn3 = section(plan("04.md"), "### Turn 3", "## Done when");
    const agrees = turn3.includes("nonempty") ? roots === nonempty : roots === chats;
    assert.equal(listMessages(empty.id).length, 0);
    assert.equal(agrees, true, `roots ${roots}, chats ${chats}, nonempty ${nonempty}`);
  } finally {
    process.chdir(cwd);
  }
});
