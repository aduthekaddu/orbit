import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function searchStopped({ page, origin, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  assert.equal(created.status(), 201);
  const { id } = await created.json();
  const messages = path.resolve("src/lib/messages.ts");
  const search = path.resolve("src/lib/tools/search.ts");
  execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const { upsertMessage } = require(${JSON.stringify(messages)});
    const { searchWeb } = require(${JSON.stringify(search)});
    (async () => {
      const id = process.argv[1];
      const output = await searchWeb({ searxngUrl: "", tavilyApiKey: "" }, "orbit", AbortSignal.abort());
      upsertMessage(id, { id: id + "-prompt", role: "user", parts: [{ type: "text", text: "Search orbit" }] });
      upsertMessage(id, { id: id + "-reply", role: "assistant", parts: [{
        type: "tool-web_search", toolCallId: "stopped-search", state: "output-available", input: { query: "orbit" }, output,
      }] });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, id], { cwd: path.resolve(".verify/sandbox"), stdio: "pipe" });
  await page.goto(`${origin}/c/${id}`);
  const card = page.locator('[data-tool-name="web_search"]');
  await card.waitFor();
  const status = await card.getByRole("status").innerText();
  step("a completed stopped search shows Cancelled", status === "Cancelled", `received ${status}`);
  await shot("stopped-output");
  await page.reload();
  await card.waitFor();
  const reloaded = await card.getByRole("status").innerText();
  step("the stopped output remains Cancelled after reload", reloaded === "Cancelled", `received ${reloaded}`);
  await shot("stopped-reloaded");
}
