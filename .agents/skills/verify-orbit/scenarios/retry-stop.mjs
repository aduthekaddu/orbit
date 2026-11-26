import { eventually } from "../../../../src/lib/eventually.mjs";
export default async function retryStop({ page, origin, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  await page.goto(`${origin}/c/${id}`);

  const composer = page.getByRole("textbox");
  await composer.fill(`[qa:fail-first] hello ${Date.now()}`);
  await composer.press("Enter");

  const retry = page.getByRole("button", { name: "Retry" });
  await retry.waitFor({ timeout: 30_000 });
  step("first send shows Retry", true);

  await retry.click();
  const reply = page.locator('[data-message-role="assistant"]').last();
  await reply.getByText("word3").waitFor({ timeout: 15_000 });
  await shot("before-stop");

  await page.getByRole("button", { name: "Stop" }).click();
  const ended = await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 3_000 }).then(() => true, () => false);
  const replyText = (target) => target.evaluate(element => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll("[data-branch-picker], [data-reply-end], button").forEach(node => node.remove());
    return copy.textContent.trim();
  });
  const seen = await replyText(reply);
  const stopped = reply.locator('[data-reply-end="stopped"]');
  await stopped.waitFor({ timeout: 5_000 });
  step("Stop ends the stream early", ended && !seen.includes("word50"), `ended=${ended} text "${seen}"`);
  step("reply text visible at stop", seen.includes("word3"), `text was "${seen}"`);

  await eventually(async () => {
    const { messages } = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    return messages.some(({ message }) => message.role === "assistant");
  }, Boolean, { timeoutMs: 5_000, what: "the stopped reply saved in the chat" });
  await page.reload();
  await page.locator('[data-turn-id]').first().waitFor({ timeout: 15_000 });
  const saved = page.locator('[data-message-role="assistant"]');
  const savedText = (await saved.count()) > 0 ? await replyText(saved.last()) : "";
  await shot("after-reload");
  step("reply text survives reload", savedText.includes(seen), `before stop "${seen}", after reload "${savedText}"`);
  step("Stopped survives reload", await saved.last().locator('[data-reply-end="stopped"]').isVisible());
  step("one reply after reload", (await saved.count()) === 1, `found ${await saved.count()} replies`);
}
