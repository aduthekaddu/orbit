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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1)?.textContent.includes("word40"), null, { timeout: 15_000 });
  const following = await page.waitForFunction(() => {
    const el = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1);
    const viewport = el.closest(".overflow-y-auto");
    const rect = el.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return rect.top < bounds.bottom && rect.bottom > bounds.top && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 12;
  }, null, { timeout: 1_000 }).then(() => true, () => false);
  const position = await page.locator('[data-message-role="assistant"]').last().evaluate((el) => {
    const viewport = el.closest(".overflow-y-auto");
    return { gap: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight, replyTop: el.getBoundingClientRect().top, viewportBottom: viewport.getBoundingClientRect().bottom };
  });
  await shot("follow-up-stream");
  step("follow-up reply stays in view while streaming", following, JSON.stringify(position));
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 20_000 });
}
