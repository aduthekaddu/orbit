import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixtureProcessOptions } from "../fixture-process.mjs";

export default async function sandboxStopped({ page, origin, step, shot }) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const repo = fileURLToPath(new URL("../../../..", import.meta.url));
  const seeded = spawnSync(process.execPath, ["--require", "tsx/cjs", "-e", `
    const { Redactor } = require(${JSON.stringify(`${repo}/src/lib/chat-errors.ts`)});
    const { finishChatReply, planChatWrite } = require(${JSON.stringify(`${repo}/src/lib/messages.ts`)});
    const chat = process.argv[1];
    const redact = new Redactor(null);
    const plan = planChatWrite(chat, [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Run a loop, then stop." }] }], redact);
    if ("error" in plan || !finishChatReply(plan, [{ type: "tool-run_code", toolCallId: "stopped-code", state: "output-error", input: { language: "python", code: "while True: pass" }, errorText: "Code run was stopped" }], redact)) process.exit(1);
  `, id], fixtureProcessOptions(repo));
  if (seeded.status !== 0) throw new Error("could not save the stopped code fixture");
  await page.goto(`${origin}/c/${id}`);
  const card = page.locator('[data-tool-name="run_code"]');
  await card.locator('[data-tool-status="cancelled"]').waitFor();
  step("a saved runner AbortError shows Cancelled", await card.innerText().then((text) => text.includes("while True: pass") && !text.includes("invalid result")));
  await shot("cancelled");
  await page.reload();
  await card.locator('[data-tool-status="cancelled"]').waitFor();
  step("the stopped code card stays Cancelled after reload", true);
  await shot("cancelled-reloaded");
}
