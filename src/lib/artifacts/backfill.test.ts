import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { Redactor } from "../chat-errors";
import { getDb } from "../db";
import { eventually } from "../eventually.mjs";
import { saveInstance } from "../instance-settings";
import { parseViewer } from "../policy";
import { withMigrationLock } from "../db/migration-lock";
import * as backfillModule from "./backfill";
import { backfillArtifacts } from "./backfill";
import { getArtifact, listArtifacts, renameArtifact } from "./store";

const USER = parseViewer({ id: "u-backfill", role: "admin" }).id;
const sqlite = () => getDb().$client;
const lockDirs: string[] = [];
const holders: ChildProcess[] = [];

function lockDir() {
  const dir = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, "backfill-lock-"));
  lockDirs.push(dir);
  return dir;
}

before(() => {
  sqlite().prepare("INSERT INTO user (id, name, email, role) VALUES (?, 'Backfill', 'backfill@orbit.test', 'admin')").run(USER);
});

after(async () => {
  await Promise.all(holders.map((holder) => new Promise((resolve) => {
    if (holder.exitCode !== null || holder.signalCode !== null) resolve(null);
    else {
      holder.once("exit", resolve);
      holder.kill("SIGKILL");
    }
  })));
  getDb().$client.close();
  for (const dir of lockDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The lock a backfill pass holds, which other processes coordinate on. Undefined before it had its own file.
const BACKFILL_LOCK = (backfillModule as { BACKFILL_LOCK?: string }).BACKFILL_LOCK;

// Another process that holds the backfill's lock in `dir` until it is killed, like a second server mid-pass.
async function holdLock(dir: string) {
  const holder = spawn(process.execPath, ["--import", "tsx", "-e", `
    import("./src/lib/db/migration-lock.ts").then((mod) => {
      const withMigrationLock = mod.withMigrationLock ?? mod.default.withMigrationLock;
      withMigrationLock(() => {
        console.log("HOLD");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      }, { dir: ${JSON.stringify(dir)}, lock: ${JSON.stringify(BACKFILL_LOCK)}, timeoutMs: 20_000 });
    });
  `], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  holders.push(holder);
  let output = "";
  holder.stdout?.on("data", (chunk) => { output += chunk; });
  await eventually(() => output, (text) => text.includes("HOLD"), { timeoutMs: 15_000, what: "the other process to hold the lock" });
  return holder;
}

let clock = 10_000;
function chat(id: string) {
  sqlite().prepare("INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(id, USER, `Title of ${id}`);
}

// A row saved before Slice 21: content holds the text, parts the JSON array, and no artifact row exists.
function legacy(chatId: string, id: string, role: "user" | "assistant", parentId: string | null, body: string, parts = JSON.stringify([{ type: "text", text: body }])) {
  clock += 1_000;
  sqlite().prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, parts, position, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
    .run(id, chatId, parentId, role, body, parts, clock);
  return clock;
}

type Row = { id: string; messageId: string; lineageId: string; userTitle: string | null; kind: string; createdAt: number; updatedAt: number };

function rows(): Row[] {
  return sqlite().prepare(`SELECT id, message_id AS messageId, lineage_id AS lineageId, user_title AS userTitle, kind,
    created_at AS createdAt, updated_at AS updatedAt FROM artifacts ORDER BY message_id, seq`).all() as Row[];
}

const stamp = () => sqlite().prepare("SELECT artifacts_backfilled_at FROM instance_settings WHERE id = 1").pluck().get() as number | null;

test("a fresh install scans nothing, stamps the pass, and skips it on the next boot", () => {
  assert.equal(stamp(), null);
  const first = backfillArtifacts({ lockDir: lockDir() });
  assert.deepEqual({ ...first, durationMs: 0 }, { skipped: false, scannedMessages: 0, insertedRows: 0, skippedCorrupt: 0, durationMs: 0 });
  assert.notEqual(stamp(), null);
  assert.deepEqual(backfillArtifacts({ lockDir: lockDir() }), { skipped: true, scannedMessages: 0, insertedRows: 0, skippedCorrupt: 0, durationMs: 0 });
});

test("an existing database backfills its artifacts once, survives a crash rerun, and is never parsed again", (t) => {
  sqlite().exec("UPDATE instance_settings SET artifacts_backfilled_at = NULL");
  chat("bf-versions");
  legacy("bf-versions", "bf-p", "user", null, "Make a counter ```html please");
  const v1Time = legacy("bf-versions", "bf-a1", "assistant", "bf-p", "``` html\n<title>Counter</title><p>Version 1</p>\n```");
  const v2Time = legacy("bf-versions", "bf-a2", "assistant", "bf-p", "```html\n<title>Counter</title><p>Version 2</p>\n```");
  chat("bf-tilde");
  legacy("bf-tilde", "bf-tilde-p", "user", null, "Draw a logo");
  legacy("bf-tilde", "bf-tilde-a", "assistant", "bf-tilde-p", "~~~svg\n<svg><title>Logo</title></svg>\n~~~");
  chat("bf-python");
  legacy("bf-python", "bf-python-p", "user", null, "Print one");
  legacy("bf-python", "bf-python-a", "assistant", "bf-python-p", "```python\nprint(1)\n```");
  chat("bf-corrupt");
  legacy("bf-corrupt", "bf-corrupt-p", "user", null, "Broken");
  legacy("bf-corrupt", "bf-corrupt-a", "assistant", "bf-corrupt-p", "```html zzcorruptcontent", "{not json zzcorruptcontent");
  chat("bf-prose");
  legacy("bf-prose", "bf-prose-p", "user", null, "Hi");
  legacy("bf-prose", "bf-prose-a", "assistant", "bf-prose-p", "Hello there, no code here.");

  const warn = t.mock.method(console, "warn", () => {});
  const first = backfillArtifacts({ batchSize: 2, lockDir: lockDir() });
  assert.deepEqual({ ...first, durationMs: 0 }, { skipped: false, scannedMessages: 5, insertedRows: 3, skippedCorrupt: 1, durationMs: 0 });
  assert.ok(first.durationMs >= 0);
  assert.equal(warn.mock.callCount(), 1);
  const logged = JSON.stringify(warn.mock.calls[0].arguments);
  assert.match(logged, /1/);
  assert.equal(logged.includes("zzcorruptcontent"), false);
  assert.notEqual(stamp(), null);

  const saved = rows();
  assert.deepEqual(saved.map((row) => [row.messageId, row.kind]), [["bf-a1", "html"], ["bf-a2", "html"], ["bf-tilde-a", "svg"]]);
  const [v1, v2, logo] = saved;
  assert.equal(v2.lineageId, v1.id);
  assert.deepEqual([v1.createdAt, v1.updatedAt, v2.createdAt, v2.updatedAt], [v1Time, v1Time, v2Time, v2Time]);
  assert.deepEqual(getArtifact(USER, v2.id)?.versions.map((version) => version.number), [1, 2]);

  // A crash after the first batches: the stamp is still empty, one chat has no rows yet, and the user renamed a row.
  sqlite().exec("UPDATE instance_settings SET artifacts_backfilled_at = NULL");
  sqlite().prepare("DELETE FROM artifacts WHERE id = ?").run(logo.id);
  assert.ok(renameArtifact(USER, v1.id, "Tally", new Redactor(null)));
  const rerun = backfillArtifacts({ batchSize: 2, lockDir: lockDir() });
  assert.deepEqual({ ...rerun, durationMs: 0 }, { skipped: false, scannedMessages: 5, insertedRows: 1, skippedCorrupt: 1, durationMs: 0 });
  const after = rows();
  assert.deepEqual(after.map((row) => [row.messageId, row.kind]), [["bf-a1", "html"], ["bf-a2", "html"], ["bf-tilde-a", "svg"]]);
  assert.deepEqual(after.slice(0, 2).map((row) => [row.id, row.lineageId, row.userTitle]), [[v1.id, v1.id, "Tally"], [v2.id, v1.id, "Tally"]]);
  assert.notEqual(stamp(), null);

  // Once stamped, a boot reads no messages and takes no lock, so a reply saved without its rows stays without them.
  chat("bf-late");
  legacy("bf-late", "bf-late-p", "user", null, "Late");
  legacy("bf-late", "bf-late-a", "assistant", "bf-late-p", "```html\n<title>Late</title>\n```");
  const quiet = lockDir();
  assert.deepEqual(backfillArtifacts({ lockDir: quiet }), { skipped: true, scannedMessages: 0, insertedRows: 0, skippedCorrupt: 0, durationMs: 0 });
  assert.deepEqual(fs.readdirSync(quiet), []);
  assert.equal(rows().length, 3);
});

test("a boot that finds another process holding the lock skips the backfill instead of failing, and a later boot runs it", async () => {
  sqlite().exec("UPDATE instance_settings SET artifacts_backfilled_at = NULL");
  const dir = lockDir();
  const holder = await holdLock(dir);
  const started = performance.now();
  assert.deepEqual(backfillArtifacts({ lockDir: dir, lockTimeoutMs: 200 }), { skipped: true, scannedMessages: 0, insertedRows: 0, skippedCorrupt: 0, durationMs: 0 });
  assert.ok(performance.now() - started < 5_000, "the boot waited at most about the lock timeout");
  assert.equal(stamp(), null);
  assert.equal(rows().length, 3);

  const exited = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill("SIGKILL");
  await exited;
  const later = backfillArtifacts({ lockDir: dir });
  assert.deepEqual({ ...later, durationMs: 0 }, { skipped: false, scannedMessages: 6, insertedRows: 1, skippedCorrupt: 1, durationMs: 0 });
  assert.deepEqual(rows().map((row) => row.messageId), ["bf-a1", "bf-a2", "bf-late-a", "bf-tilde-a"]);
  assert.notEqual(stamp(), null);
});

test("a running backfill does not hold the lock that opening the database waits for", async () => {
  const dir = lockDir();
  await holdLock(dir);
  assert.equal(withMigrationLock(() => "entered", { dir, timeoutMs: 200 }), "entered");
});

test("a backfill masks each reply with its owner's credentials before it indexes the artifacts, and leaves the message as saved", () => {
  // A reply saved before messages were masked on write still holds the admin's search key.
  const key = "zq9backfillsecret0042";
  assert.ok(saveInstance(USER, { tavilyApiKey: key }).ok);
  sqlite().exec("UPDATE instance_settings SET artifacts_backfilled_at = NULL");
  chat("bf-secret");
  legacy("bf-secret", "bf-secret-p", "user", null, "Show the key");
  const body = `\`\`\`html\n<title>Key ${key}</title><p>${key}</p>\n\`\`\``;
  legacy("bf-secret", "bf-secret-a", "assistant", "bf-secret-p", body);
  backfillArtifacts({ lockDir: lockDir() });

  const row = sqlite().prepare("SELECT id, code, derived_title AS derivedTitle FROM artifacts WHERE message_id = 'bf-secret-a'").get() as { id: string; code: string; derivedTitle: string };
  assert.equal(row.code, "<title>Key [redacted]</title><p>[redacted]</p>\n");
  assert.equal(row.derivedTitle, "Key [redacted]");
  assert.equal(getArtifact(USER, row.id)?.code.includes(key), false);
  assert.equal(sqlite().prepare("SELECT count(*) FROM artifacts_fts WHERE artifacts_fts MATCH ?").pluck().get(`"${key}"`), 0);
  assert.deepEqual(listArtifacts(USER, { q: key }).items, []);
  assert.deepEqual(JSON.parse(sqlite().prepare("SELECT parts FROM messages WHERE id = 'bf-secret-a'").pluck().get() as string), [{ type: "text", text: body }]);
});
