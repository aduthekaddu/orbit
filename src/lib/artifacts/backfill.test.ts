import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { Redactor } from "../chat-errors";
import { getDb } from "../db";
import { parseViewer } from "../policy";
import { backfillArtifacts } from "./backfill";
import { getArtifact, renameArtifact } from "./store";

const USER = parseViewer({ id: "u-backfill", role: "admin" }).id;
const sqlite = () => getDb().$client;
const lockDirs: string[] = [];

function lockDir() {
  const dir = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, "backfill-lock-"));
  lockDirs.push(dir);
  return dir;
}

before(() => {
  sqlite().prepare("INSERT INTO user (id, name, email, role) VALUES (?, 'Backfill', 'backfill@orbit.test', 'admin')").run(USER);
});

after(() => {
  getDb().$client.close();
  for (const dir of lockDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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
    created_at AS createdAt, updated_at AS updatedAt FROM artifacts ORDER BY seq`).all() as Row[];
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
