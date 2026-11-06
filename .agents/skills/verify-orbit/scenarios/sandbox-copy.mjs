const channels = [
  { label: "Copy source", saved: (part) => part.input.code, done: "Source copied" },
  { label: "Copy standard output", saved: (part) => part.output.stdout, done: "Standard output copied" },
  { label: "Copy standard error", saved: (part) => part.output.stderr, done: "Standard error copied" },
];

export default async function sandboxCopy({ page, origin, step, shot }) {
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const card = page.locator('[data-tool-name="run_code"]');
  await composer.fill("[qa:run-copy]");
  await composer.press("Enter");
  await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 25_000 });

  let part;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const body = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    const reply = body.messages.map(({ message }) => message).find((message) => message.role === "assistant");
    part = reply?.parts.find((entry) => entry.type === "tool-run_code" && entry.state === "output-available");
    if (part) break;
    await page.waitForTimeout(250);
  }
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const clear = () => page.evaluate(() => navigator.clipboard.writeText(""));
  console.log(`saved source ${JSON.stringify(part?.input.code.slice(0, 40))} stdout ${JSON.stringify(part?.output.stdout)} stderr ${JSON.stringify(part?.output.stderr)}`);

  let missing = false;
  for (const { label, saved, done } of channels) {
    const button = card.getByRole("button", { name: label });
    const present = (await button.count()) === 1;
    step(`${label} button is on the card`, present);
    if (!present) {
      missing = true;
      continue;
    }
    await clear();
    await button.click();
    await card.locator('[aria-live="polite"]').filter({ hasText: done }).waitFor({ state: "attached", timeout: 3_000 }).catch(() => {});
    const copied = await clipboard();
    step(`${label} copies the saved text exactly`, copied === saved(part), `clipboard ${JSON.stringify(copied)}`);
    if (label === "Copy standard output") await shot("copied");
  }

  if (missing) {
    await shot("card-without-copy-buttons");
    return;
  }
  const stdoutButton = card.getByRole("button", { name: "Copy standard output" });
  for (const key of ["Enter", "Space"]) {
    await clear();
    await stdoutButton.focus();
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    step(`${key} on the focused copy button copies the standard output`, (await clipboard()) === part.output.stdout, `clipboard ${JSON.stringify(await clipboard())}`);
  }

  await page.waitForTimeout(1_800);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("denied")) });
  });
  await stdoutButton.click();
  const failed = await card.locator('[aria-live="polite"]').filter({ hasText: "Copy failed" }).waitFor({ state: "attached", timeout: 3_000 }).then(() => true, () => false);
  step("a rejected clipboard write says Copy failed", failed);
  await shot("copy-failed");

  await page.reload();
  await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 15_000 });
  await clear();
  await card.getByRole("button", { name: "Copy source" }).click();
  await page.waitForTimeout(300);
  step("the reopened card still copies the source exactly", (await clipboard()) === part.input.code);

  const browser = context.browser();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await mobile.addCookies(await context.cookies());
  const phone = await mobile.newPage();
  await phone.goto(`${origin}/c/${id}`);
  const phoneCard = phone.locator('[data-tool-name="run_code"]');
  await phoneCard.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 15_000 });
  for (const { label } of channels) {
    const box = await phoneCard.getByRole("button", { name: label }).boundingBox();
    step(`${label} has a 44 pixel touch target at 390 pixels`, Boolean(box) && box.width >= 44 && box.height >= 44, JSON.stringify(box));
  }
  const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  step("the card with its copy buttons fits the 390 pixel page", fits);
  await phoneCard.scrollIntoViewIfNeeded();
  await shot("phone", phone);
  await mobile.close();
}
