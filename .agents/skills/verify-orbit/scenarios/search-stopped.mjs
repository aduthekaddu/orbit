import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { startMockSearxng } from "../../../../scripts/qa/mock-searxng.mjs";

export default async function searchStopped({ page, origin, mockUrl, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  assert.equal(created.status(), 201);
  const { id } = await created.json();
  const messages = path.resolve("src/lib/messages.ts");
  const search = path.resolve("src/lib/tools/search.ts");
  execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const { Redactor } = require(${JSON.stringify(path.resolve("src/lib/chat-errors.ts"))});
    const { finishChatReply, planChatWrite } = require(${JSON.stringify(messages)});
    const { searchWeb } = require(${JSON.stringify(search)});
    (async () => {
      const id = process.argv[1];
      const output = await searchWeb({ searxngUrl: "", tavilyApiKey: "" }, "orbit", AbortSignal.abort());
      const redact = new Redactor(null);
      const plan = planChatWrite(id, [{ id: id + "-prompt", role: "user", parts: [{ type: "text", text: "Search orbit" }] }], redact);
      if ("error" in plan || !finishChatReply(plan, [{
        type: "tool-web_search", toolCallId: "stopped-search", state: "output-available", input: { query: "orbit" }, output,
      }], redact)) process.exitCode = 1;
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, id], { cwd: path.resolve(".verify/sandbox"), env: { ...process.env, ORBIT_DATA_DIR: path.resolve(".verify/sandbox/data") }, stdio: "pipe" });
  const stored = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
  assert.equal(stored.messages.some(({ message }) => message.parts?.some((part) => part.toolCallId === "stopped-search")), true, "stopped search fixture was not saved in the verifier sandbox");
  await page.goto(`${origin}/c/${id}`);
  const card = page.locator('[data-tool-name="web_search"]');
  await card.waitFor();
  const status = await card.getByRole("status").innerText();
  step("a completed stopped search reads Search stopped", status === "Search stopped", `received ${status}`);
  await shot("stopped-output");
  await page.reload();
  await card.waitFor();
  const reloaded = await card.getByRole("status").innerText();
  step("the stopped output still reads Search stopped after reload", reloaded === "Search stopped", `received ${reloaded}`);
  await shot("stopped-reloaded");
  const mock = await startMockSearxng();
  try {
    const saved = await page.request.put(`${origin}/api/settings`, { data: {
      baseUrl: mockUrl, model: "mock-genui", reasoningEffort: "low", searxngUrl: mock.url, tavilyApiKey: null,
    } });
    assert.equal(saved.status(), 200);
    const { id: liveId } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${liveId}`);
    const held = [];
    let holding = true;
    await page.route((url) => url.pathname === `/api/chats/${liveId}`, (route) => {
      if (holding && route.request().method() === "GET") held.push(route);
      else route.continue();
    });
    const composer = page.getByPlaceholder("Ask anything");
    const liveCard = page.locator('[data-tool-name="web_search"]');
    await composer.fill("[qa:search] slow orbit");
    await composer.press("Enter");
    await liveCard.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
    await composer.fill("sent right after Stop");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await liveCard.locator('[data-tool-status="cancelled"]').waitFor({ timeout: 8_000 });
    await composer.press("Enter");
    await page.getByText("sent right after Stop", { exact: true }).waitFor({ timeout: 5_000 });
    holding = false;
    const heldCount = held.length;
    await Promise.all(held.splice(0).map((route) => route.continue().catch(() => {})));
    const statusAfterSend = await liveCard.getByRole("status").innerText();
    step("a message sent right after Stop leaves the line at Search stopped, not Search failed", statusAfterSend === "Search stopped", `line ${statusAfterSend}, held reads ${heldCount}`);
    await shot("send-after-stop");
  } finally {
    await mock.close();
  }
}
