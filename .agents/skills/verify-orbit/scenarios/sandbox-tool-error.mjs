import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixtureProcessOptions } from "../fixture-process.mjs";

export default async function sandboxToolError({ page, origin, step, shot }) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const repo = fileURLToPath(new URL("../../../..", import.meta.url));
  const saved = spawnSync(process.execPath, ["--require", "tsx/cjs", "-e", `
    const { Redactor } = require(${JSON.stringify(`${repo}/src/lib/chat-errors.ts`)});
    const { finishChatReply, planChatWrite } = require(${JSON.stringify(`${repo}/src/lib/messages.ts`)});
    const chat = process.argv[1];
    const redact = new Redactor(null);
    const plan = planChatWrite(chat, [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Run Ruby code." }] }], redact);
    if ("error" in plan || !finishChatReply(plan, [{ type: "tool-run_code", toolCallId: "invalid-code", state: "output-error", input: { language: "ruby", code: "puts 1" }, errorText: "Unsupported language. Use Python or JavaScript." }], redact)) process.exit(1);
  `, id], fixtureProcessOptions(repo));
  if (saved.status !== 0) throw new Error("could not save the framework error fixture");
  await page.goto(`${origin}/c/${id}`);
  const card = page.locator('[data-tool-name="run_code"]');
  await card.locator('[data-tool-status="failed"]').waitFor();
  step("the code card shows the framework failure reason", (await card.innerText()).includes("Unsupported language. Use Python or JavaScript."));
  await shot("failure");
  await page.reload();
  await card.locator('[data-tool-status="failed"]').waitFor();
  step("the framework failure reason survives reload", (await card.innerText()).includes("Unsupported language. Use Python or JavaScript."));
  await shot("failure-reloaded");
}
