import fs from "node:fs";
import path from "node:path";

const requestLog = path.join(process.cwd(), ".verify", "mock-requests.jsonl");

function requests() {
  if (!fs.existsSync(requestLog)) return [];
  return fs
    .readFileSync(requestLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function bodyHas(entry, text) {
  return JSON.stringify(entry.body ?? {}).includes(text);
}

function instructionExcerpt(entry) {
  const messages = Array.isArray(entry.body?.messages) ? entry.body.messages : [];
  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const index = content.indexOf("Things the user told you before");
    if (index >= 0) return content.slice(index, index + 280);
  }
  return "";
}

function writeRequestProof(name) {
  const dir = path.join(process.cwd(), ".verify", "evidence", "memory");
  fs.mkdirSync(dir, { recursive: true });
  const lines = requests().map((entry) =>
    JSON.stringify({
      scenario: entry.scenario,
      hasQuestion: bodyHas(entry, "Where should hosting live?"),
      hasFly: bodyHas(entry, "I deploy to Fly.io"),
      hasRender: bodyHas(entry, "I ship to Render"),
      excerpt: instructionExcerpt(entry),
    }),
  );
  fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`);
}

export default async function memory({ page, origin, step, shot }) {
  fs.mkdirSync(path.dirname(requestLog), { recursive: true });
  fs.writeFileSync(requestLog, "");

  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  await page.goto(`${origin}/c/${id}`);
  await page.getByRole("textbox").fill("[qa:remember] I deploy to Fly.io");
  await page.getByRole("textbox").press("Enter");
  const savedReply = page.locator('[data-message-role="assistant"]').getByText("Saved.", { exact: true });
  const replied = await savedReply.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  step("remember tool saves from chat", replied);

  await page.goto(`${origin}/memory`);
  const row = page.getByText("I deploy to Fly.io", { exact: true });
  const listed = await row.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  await shot("page");
  step("memory page lists the saved fact", listed);
  step("embeddings are on", await page.getByText("Embeddings on", { exact: true }).isVisible().catch(() => false));

  const search = page.getByRole("textbox", { name: "Search" });
  await search.fill("Fly");
  await page.waitForTimeout(400);
  step("search keeps the matching memory", await row.isVisible());
  await search.fill("nomatchtoken");
  await page.waitForTimeout(400);
  step("search hides a memory that does not match", !(await row.isVisible().catch(() => false)));
  await search.fill("");
  await row.waitFor({ timeout: 5_000 });

  fs.writeFileSync(requestLog, "");
  const followUp = await page.request.post(`${origin}/api/chats`);
  const { id: secondId } = await followUp.json();
  await page.goto(`${origin}/c/${secondId}`);
  await page.getByRole("textbox").fill("[qa:plain] Where should hosting live?");
  await page.getByRole("textbox").press("Enter");
  const followReply = page.locator('[data-message-role="assistant"]').getByText("pong", { exact: true });
  const followed = await followReply.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const injected = requests().some((entry) => bodyHas(entry, "Where should hosting live?") && bodyHas(entry, "I deploy to Fly.io"));
  writeRequestProof("injected.jsonl");
  step("a new chat sends the memory in the model instructions", followed && injected, followed ? "request log has no memory" : "no reply");

  await page.goto(`${origin}/memory`);
  await page.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Memory" });
  await editor.fill("I ship to Render");
  await page.getByRole("button", { name: "Save" }).click();
  const editorClosed = await editor.waitFor({ state: "hidden", timeout: 10_000 }).then(() => true, () => false);
  const edited = page.getByText("I ship to Render", { exact: true });
  const editedVisible = editorClosed && (await edited.waitFor({ timeout: 10_000 }).then(() => true, () => false));
  await shot("edited");
  step("edit saves the new text", editedVisible);

  const ollamaUrl = process.env.ORBIT_OLLAMA_URL;
  if (ollamaUrl) {
    await page.request.post(`${ollamaUrl}/qa/fail`);
    await page.goto(`${origin}/memory`);
    const down = await page.getByText(/Ollama/).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await shot("ollama-down");
    step("the page shows the Ollama error", down && !(await page.getByText("Embeddings on", { exact: true }).isVisible().catch(() => false)));
    await page.request.post(`${ollamaUrl}/qa/ok`);
  } else {
    await shot("ollama-down");
    step("the page shows the Ollama error", false, "ORBIT_OLLAMA_URL is unset");
  }

  await page.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this memory?" });
  await confirm.waitFor({ timeout: 5_000 });
  await confirm.getByRole("button", { name: "Delete" }).click();
  const gone = await page.getByText("I ship to Render", { exact: true }).waitFor({ state: "hidden", timeout: 10_000 }).then(() => true, () => false);
  step("delete removes the memory", gone);

  fs.writeFileSync(requestLog, "");
  const third = await page.request.post(`${origin}/api/chats`);
  const { id: thirdId } = await third.json();
  await page.goto(`${origin}/c/${thirdId}`);
  await page.getByRole("textbox").fill("[qa:plain] Where should hosting live?");
  await page.getByRole("textbox").press("Enter");
  await page.locator('[data-message-role="assistant"]').getByText("pong", { exact: true }).waitFor({ timeout: 30_000 }).catch(() => {});
  const leaked = requests().some((entry) => bodyHas(entry, "I ship to Render") || bodyHas(entry, "I deploy to Fly.io"));
  writeRequestProof("after-delete.jsonl");
  step("a deleted memory is not sent again", !leaked);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/memory`);
  await page.getByRole("heading", { name: "Memory" }).first().waitFor({ timeout: 10_000 });
  await shot("mobile");
  step("memory page renders at 390 by 844", true);

  await page.goto(`${origin}/c/${id}`);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator("input").fill("Memory");
  await dialog.getByText("Memory", { exact: true }).click();
  await page.waitForURL(/\/memory$/, { timeout: 10_000 }).catch(() => {});
  step("palette opens Memory", page.url().endsWith("/memory"), `url is ${page.url()}`);
}
