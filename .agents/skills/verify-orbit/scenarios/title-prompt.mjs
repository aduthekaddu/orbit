import fs from "node:fs";
import path from "node:path";
import { eventually } from "../../../../src/lib/eventually.mjs";

const requestLog = path.join(process.cwd(), ".verify", "mock-requests.jsonl");

function requests() {
  if (!fs.existsSync(requestLog)) return [];
  return fs
    .readFileSync(requestLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function userText(entry) {
  const messages = Array.isArray(entry.body?.messages) ? entry.body.messages : [];
  return messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
    .join("");
}

export default async function titlePrompt({ page, origin, step, shot }) {
  fs.mkdirSync(path.dirname(requestLog), { recursive: true });
  fs.writeFileSync(requestLog, "");

  const head = `[qa:plain] title source ${Date.now()} `;
  const message = `${head}${"a".repeat(200_000 - head.length)}`;
  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  await page.goto(`${origin}/c/${id}`);
  await page.getByRole("textbox").fill(message);
  await page.getByRole("textbox").press("Enter");
  const replied = await page
    .locator('[data-message-role="assistant"]')
    .getByText("pong", { exact: true })
    .waitFor({ timeout: 30_000 })
    .then(() => true, () => false);
  step("first message of 200,000 characters gets a reply", replied);

  const titleRequest = await eventually(
    () =>
      requests().find(
        (entry) => entry.body?.stream !== true && userText(entry).includes("Write a title of at most six words.") && userText(entry).includes(head),
      ),
    Boolean,
    { timeoutMs: 10_000, intervalMs: 100, what: "the title request in the mock provider log" },
  ).catch(() => undefined);
  const replyRequest = requests().find((entry) => entry.body?.stream === true && userText(entry).includes(head));
  const replyLength = replyRequest ? Array.from(userText(replyRequest)).length : 0;
  step("reply request carries the whole first message", replyLength >= message.length, `user text ${replyLength} characters`);
  const titleText = titleRequest ? userText(titleRequest) : "";
  const titleLength = Array.from(titleText).length;
  step("title request was sent", Boolean(titleRequest));
  step("title prompt holds at most 2,100 characters", titleRequest !== undefined && titleLength <= 2_100, `title prompt ${titleLength} characters`);
  step("title prompt ends with the first 2,000 characters", titleText.endsWith(message.slice(0, 2_000)));

  let titled = false;
  for (let attempt = 0; attempt < 8 && !titled; attempt += 1) {
    titled = await page.locator(`a[href="/c/${id}"]`).getByText("Mock title", { exact: true }).isVisible().catch(() => false);
    if (titled) break;
    await page.reload();
    await page.getByRole("textbox").waitFor({ timeout: 10_000 }).catch(() => {});
  }
  await shot("title");
  step("sidebar title is Mock title", titled);
}
