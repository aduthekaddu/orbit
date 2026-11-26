export default async function sandboxUnicode({ page, origin, useProvider, step, shot }) {
  await useProvider();
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  await composer.fill("[qa:run-unicode]");
  await composer.press("Enter");
  const card = page.locator('[data-tool-name="run_code"]');
  await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 20_000 });
  step("incomplete UTF-8 at the byte cap shows Output truncated", await card.getByText("Output truncated", { exact: true }).count() === 1 && (await card.locator('[data-code-stdout]').textContent()).length === 65534);
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await shot("truncated");
  await page.reload();
  await card.waitFor();
  step("the truncation marker survives reload", await card.getByText("Output truncated", { exact: true }).count() === 1);
  await page.setViewportSize({ width: 390, height: 844 });
  step("the capped output fits the mobile page", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot("mobile");
}
