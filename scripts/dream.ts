import { z } from "zod";
import { runDream } from "../src/lib/memory/dream";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function readDate(argv: string[]): string | undefined {
  let date: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--date") {
      console.error("usage: npm run dream -- [--date YYYY-MM-DD]");
      process.exit(1);
    }
    const parsed = dateSchema.safeParse(argv[index + 1]);
    if (!parsed.success) {
      console.error("date must be YYYY-MM-DD");
      process.exit(1);
    }
    date = parsed.data;
    index += 1;
  }
  return date;
}

async function main() {
  const date = readDate(process.argv.slice(2));
  const row = await runDream({ manual: true, date });
  if (!row) {
    console.error("dream did not start");
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      date: row.date,
      state: row.state,
      chats: row.chatIds.length,
      done: row.doneChatIds.length,
      retry: row.retryChatIds.length,
      added: row.added,
      merged: row.merged,
      error: row.error,
    }),
  );
  if (row.state === "failed") process.exit(1);
}

main();
