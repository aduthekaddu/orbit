export default async function palette({ page, origin, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  const chatUrl = `${origin}/c/${id}`;
  const dialog = page.getByRole("dialog", { name: "Command palette" });

  await page.goto(chatUrl);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  step("Ctrl+K opens the palette", true);
  await page.keyboard.type("Settings");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/settings$/, { timeout: 10_000 }).catch(() => {});
  await dialog.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
  await shot("after-select");
  step("Enter on Settings opens /settings", page.url().endsWith("/settings"), `url is ${page.url()}`);
  step("palette closes after select", !(await dialog.isVisible()), "dialog still visible");

  await page.goto(chatUrl);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot("after-escape");
  step("Esc closes the palette", !(await dialog.isVisible()), "dialog still visible");
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? "none");
  step("focus returns to the composer", focused === "TEXTAREA", `focus is on ${focused}`);
}
