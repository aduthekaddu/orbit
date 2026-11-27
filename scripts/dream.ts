import { parseArgs } from "node:util";
import { z } from "zod";
import { getDb } from "../src/lib/db";
import { runDream } from "../src/lib/memory/dream";
import { memoryEnabledViewers } from "../src/lib/memory/schedule";
import { parseViewer } from "../src/lib/policy";
import { getMemoryEnabled } from "../src/lib/preferences";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function readOptions() {
  try {
    return parseArgs({
      options: { date: { type: "string" }, user: { type: "string" } },
      allowPositionals: false,
    }).values;
  } catch {
    console.error("Usage: npm run dream -- [--date YYYY-MM-DD] [--user <email>]");
    process.exit(1);
  }
}

async function main() {
  const options = readOptions();
  const date = dateSchema.optional().safeParse(options.date);
  if (!date.success) {
    console.error("Date must be YYYY-MM-DD");
    process.exitCode = 1;
    return;
  }
  const selected = options.user === undefined
    ? undefined
    : getDb().$client.prepare("SELECT id, role FROM user WHERE email = ?").get(options.user);
  if (options.user !== undefined && !selected) {
    console.error("No account matches that email");
    process.exitCode = 1;
    return;
  }
  const viewers = selected ? [parseViewer(selected)] : memoryEnabledViewers();
  for (const viewer of viewers) {
    try {
      const row = await runDream({ viewer, manual: true, date: date.data });
      if (!row && !getMemoryEnabled(viewer.id)) {
        console.log(JSON.stringify({ userId: viewer.id, state: "skipped", reason: "Memory is off" }));
        continue;
      }
      if (!row) throw new Error("Dream did not start");
      console.log(JSON.stringify({
        userId: viewer.id,
        date: row.date,
        state: row.state,
        chats: row.chatIds.length,
        done: row.doneChatIds.length,
        retry: row.retryChatIds.length,
        added: row.added,
        merged: row.merged,
        error: row.error,
      }));
      if (row.state === "failed") process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ userId: viewer.id, state: "failed", error: error instanceof Error ? error.name : "Error" }));
      process.exitCode = 1;
    }
  }
}

void main();
