import { eventually } from "../../../../src/lib/eventually.mjs";

export default async function searchFocus({ page, origin, step, shot }) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const token = `focusneedle${id.replaceAll("-", "")}`;
  const longPrompt = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} fills the chat history.`).join("\n");
  let history = [];
  let targetId;
  for (const [index, text] of [`[qa:plain] ${longPrompt}`, `[qa:plain] ${token}`, `[qa:plain] ${longPrompt}`].entries()) {
    const message = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    if (index === 1) targetId = message.id;
    const sent = await page.request.post(`${origin}/api/chat`, { data: { id, messages: [...history, message], trigger: "submit-message" } });
    if (!sent.ok()) throw new Error(`Seed turn ${index + 1} returned ${sent.status()}`);
    const tree = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    history = tree.messages.map(({ message }) => message);
  }

  await page.goto(`${origin}/c/${id}`);
  await page.getByRole("textbox").waitFor();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.locator("input").fill(token);
  const hit = dialog.getByRole("option").filter({ hasText: token });
  await hit.waitFor({ timeout: 10_000 });
  const before = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
  await hit.click();
  await page.waitForURL(`${origin}/c/${id}?m=${targetId}`);
  const target = page.locator(`[data-turn-id="${targetId}"]`);
  await target.waitFor();
  const focused = await page.waitForFunction((targetId) => {
    const el = document.querySelector(`[data-turn-id="${targetId}"]`);
    if (!el) return false;
    const viewport = el.closest(".overflow-y-auto");
    const rect = el.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return rect.top >= bounds.top && rect.bottom <= bounds.bottom && getComputedStyle(el).boxShadow !== "none";
  }, targetId, { timeout: 3_000 }).then(() => true, () => false);
  await shot("user-hit");
  step("user search hit scrolls into view and is highlighted", focused, "target is outside the viewport or has no ring");
  const after = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
  step("user search hit keeps the stored head", after.headId === before.headId);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox").fill(`[qa:slow] ${longPrompt}`);
  await page.getByRole("textbox").press("Enter");
  const replyHas = (word) => page.waitForFunction((word) => [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1)?.textContent.includes(word), word, { timeout: 15_000 });
  const scrollTop = () => page.locator('[data-message-role="assistant"]').last().evaluate((el) => el.closest(".overflow-y-auto").scrollTop);
  await replyHas("word10");
  const earlyTop = await scrollTop();
  await replyHas("word40");
  // turnAnchor="top" scrolls the new prompt up once and then leaves scrollTop alone. A prompt taller than 10em
  // keeps 6em in view, so its end sits within 12em of the top, and the reply starts in view below it.
  const anchored = await page.waitForFunction((earlyTop) => {
    const reply = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1);
    const prompt = [...document.querySelectorAll("[data-turn-id]")].at(-1);
    const viewport = reply.closest(".overflow-y-auto");
    const bounds = viewport.getBoundingClientRect();
    const replyBox = reply.getBoundingClientRect();
    const promptBox = prompt.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(prompt).fontSize);
    return viewport.scrollTop - earlyTop <= 2 && replyBox.top >= bounds.top && replyBox.top < bounds.bottom && promptBox.bottom > bounds.top && promptBox.bottom - bounds.top <= 12 * em;
  }, earlyTop, { timeout: 1_000 }).then(() => true, () => false);
  const position = await page.locator('[data-message-role="assistant"]').last().evaluate((el, earlyTop) => {
    const viewport = el.closest(".overflow-y-auto");
    const bounds = viewport.getBoundingClientRect();
    const prompt = [...document.querySelectorAll("[data-turn-id]")].at(-1);
    return { scrollTopAtWord10: earlyTop, scrollTopAtWord40: viewport.scrollTop, promptBottomFromTop: prompt.getBoundingClientRect().bottom - bounds.top, em: parseFloat(getComputedStyle(prompt).fontSize), replyTopFromTop: el.getBoundingClientRect().top - bounds.top, viewportHeight: bounds.height };
  }, earlyTop);
  await shot("follow-up-stream");
  step("follow-up prompt stays anchored near the top and its reply starts in view while streaming", anchored, JSON.stringify(position));
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 20_000 });

  // Two branches. The hit is the edited question in the middle of the second one,
  // and the last turn goes to the first one, so the stored head is off the hit's branch.
  await page.setViewportSize({ width: 1280, height: 800 });
  const branchChat = (await (await page.request.post(`${origin}/api/chats`)).json()).id;
  const branchToken = `branchneedle${branchChat.replaceAll("-", "")}`;
  const user = (text) => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });
  const readTree = async () => (await page.request.get(`${origin}/api/chats/${branchChat}`)).json();
  const seed = async (path, message, editMessageId) => {
    const sent = await page.request.post(`${origin}/api/chat`, { data: { id: branchChat, messages: [...path, message], trigger: "submit-message", editMessageId } });
    if (!sent.ok()) throw new Error(`Branch seed returned ${sent.status()}`);
    const reply = (await readTree()).messages.find(({ parentId }) => parentId === message.id)?.message;
    if (!reply) throw new Error(`No reply under ${message.id}`);
    return [...path, message, reply];
  };
  const root = await seed([], user("[qa:plain] first question"));
  const storedBranch = await seed(root, user("[qa:plain] second question"));
  const edited = user(`[qa:plain] ${branchToken}`);
  const hitBranch = await seed(await seed(root, edited, storedBranch[2].id), user("[qa:plain] later question"));
  await seed(storedBranch, user("[qa:plain] stored branch question"));
  const beforeHit = await readTree();

  await page.goto(`${origin}/c/${branchChat}`);
  await page.getByRole("textbox").waitFor();
  await page.keyboard.press("Control+K");
  await dialog.locator("input").fill(branchToken);
  const branchHit = dialog.getByRole("option").filter({ hasText: branchToken });
  await branchHit.waitFor({ timeout: 10_000 });
  await branchHit.click();
  await page.waitForURL(`${origin}/c/${branchChat}?m=${edited.id}`);
  await page.locator(`[data-turn-id="${edited.id}"]`).waitFor();
  await dialog.waitFor({ state: "hidden" });
  const expected = hitBranch.map(({ id }) => id);
  const shownIds = () => page.locator("[data-message-id]").evaluateAll((els) => els.map((el) => el.dataset.messageId));
  const opened = await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll("[data-message-id]")].map((el) => el.dataset.messageId)) === JSON.stringify(expected), expected, { timeout: 3_000 }).then(() => true, () => false);
  await shot("off-branch-hit");
  step("off-branch hit opens the rest of its branch", opened, `shown=${(await shownIds()).join(",")} expected=${expected.join(",")}`);
  step("off-branch hit keeps the stored head", (await readTree()).headId === beforeHit.headId);

  const followUp = "[qa:plain] sent from the hit";
  await page.getByRole("textbox").fill(followUp);
  await page.getByRole("textbox").press("Enter");
  const sent = await eventually(
    async () => {
      const tree = await readTree();
      const prompt = tree.messages.find(({ message }) => message.role === "user" && message.parts.some((part) => part.text === followUp));
      return prompt && tree.messages.some(({ parentId }) => parentId === prompt.message.id) ? prompt : null;
    },
    Boolean,
    { timeoutMs: 20_000, intervalMs: 200, what: "the follow-up prompt and its reply saved in the chat" },
  ).catch(() => undefined);
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 20_000 });
  await shot("off-branch-sent");
  step("prompt from the hit view follows the end of its branch", sent?.parentId === expected.at(-1), `parent=${sent?.parentId} expected=${expected.at(-1)}`);
}
