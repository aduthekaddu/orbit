import { replyText } from "../../../../scripts/qa/reply-text.mjs";
export default async function longMessage({ page, origin, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();

  const direct = await page.request.post(`${origin}/api/chat`, {
    data: { id, trigger: "submit-message", messages: [{ id: `${id}-direct`, role: "user", parts: [{ type: "text", text: "a".repeat(80_000) }] }] },
  });
  const directBody = await direct.json().catch(() => ({}));
  step("80,000 letters get 413 from the route", direct.status() === 413 && directBody.error === "Message is too long.", `status ${direct.status()} ${JSON.stringify(directBody)}`);

  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByRole("textbox");
  await composer.fill("word ".repeat(12_000));
  await composer.press("Enter");
  await page.getByText("Message is too long.", { exact: true }).first().waitFor({ timeout: 15_000 }).then(
    () => step("composer shows the refusal as plain text", true),
    async () => step("composer shows the refusal as plain text", false, `no exact "Message is too long." text within 15s; page shows ${JSON.stringify(await page.getByText("Message is too long.").first().textContent().catch(() => null))}`),
  );
  await shot("too-long");

  const { messages } = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
  step("a refused message is not saved", messages.length === 0, `${messages.length} messages saved`);

  await page.reload();
  const next = page.getByRole("textbox");
  await next.fill(`short question ${Date.now()}`);
  await next.press("Enter");
  const reply = page.locator('[data-message-role="assistant"]').last();
  await reply.waitFor({ timeout: 30_000 });
  step("a short message still gets a reply", (await replyText(reply)).length > 0);
}
