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
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 10_000 });
  const seen = (await reply.innerText()).trim();
  step("reply text visible at stop", seen.includes("word3"), `text was "${seen}"`);

  await page.waitForTimeout(1_500);
  await page.reload();
  await page.locator('[data-turn-id]').first().waitFor({ timeout: 15_000 });
  const saved = page.locator('[data-message-role="assistant"]');
  const savedText = (await saved.count()) > 0 ? (await saved.last().innerText()).trim() : "";
  await shot("after-reload");
  step("reply text survives reload", savedText.includes(seen), `before stop "${seen}", after reload "${savedText}"`);
}
