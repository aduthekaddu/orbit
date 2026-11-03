export default async function search({ page, origin, step, shot }) {
  const stack = ["Error: disk full", "    at boot (init.js:1:1)", "    at main (init.js:9:1)"].join("\n");
  const createdA = await page.request.post(`${origin}/api/chats`);
  const { id: firstId } = await createdA.json();
  const createdB = await page.request.post(`${origin}/api/chats`);
  const { id: secondId } = await createdB.json();

  await page.goto(`${origin}/c/${secondId}`);
  await page.getByRole("textbox").fill(`[qa:zebracorn] ${stack}`);
  await page.getByRole("textbox").press("Enter");
  const reply = page.getByText("zebracorn");
  const replied = await reply.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  step("second chat gets a reply", replied);
  await shot("long-title");

  await page.goto(`${origin}/c/${firstId}`);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator("input").fill("zebracorn");
  await page.waitForTimeout(400);
  const heading = dialog.getByText("Messages", { exact: true });
  const visible = await heading.isVisible().catch(() => false);
  await shot(visible ? "results" : "before");
  step("Messages result for zebracorn", visible, "no Messages group");
  if (!visible) return;
  const hit = dialog.getByText("stood in the road");

  const before = await (await page.request.get(`${origin}/api/chats/${secondId}`)).json();
  await hit.click();
  await page.waitForURL(new RegExp(`/c/${secondId}\\?m=`), { timeout: 10_000 });
  await page.getByText("zebracorn").first().waitFor({ timeout: 10_000 });
  await shot("opened");
  const after = await (await page.request.get(`${origin}/api/chats/${secondId}`)).json();
  step("opened chat shows the matching message", await page.getByText("zebracorn").first().isVisible());
  step("opening the hit keeps the stored head", after.headId === before.headId, `before=${before.headId} after=${after.headId}`);

  let titled = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    titled = await page.getByRole("link", { name: "Mock title" }).isVisible().catch(() => false);
    if (titled) break;
    await page.reload();
    await page.getByRole("textbox").waitFor({ timeout: 10_000 }).catch(() => {});
  }
  await shot("title");
  step("sidebar title is Mock title", titled);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator("input").fill("zebracorn");
  await dialog.getByText("zebracorn").first().waitFor({ timeout: 5_000 });
  await shot("mobile");
  step("mobile palette shows the message", await dialog.getByText("zebracorn").first().isVisible());
}
