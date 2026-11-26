import { eventually } from "../../../../src/lib/eventually.mjs";
const channels = [
  { label: "Copy source", saved: (part) => part.input.code, done: "Source copied" },
  { label: "Copy standard output", saved: (part) => part.output.stdout, done: "Standard output copied" },
  { label: "Copy standard error", saved: (part) => part.output.stderr, done: "Standard error copied" },
];

export default async function sandboxCopy({ page, origin, useProvider, step, shot }) {
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await useProvider();
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const card = page.locator('[data-tool-name="run_code"]');
  await composer.fill("[qa:run-copy]");
  await composer.press("Enter");
  await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 25_000 });

  const part = await eventually(async () => {
    const body = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    const reply = body.messages.map(({ message }) => message).find((message) => message.role === "assistant");
    return reply?.parts.find((entry) => entry.type === "tool-run_code" && entry.state === "output-available");
  }, Boolean, { timeoutMs: 8_000, what: "the finished run saved in the chat" });
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
    const confirmed = await card.locator('[aria-live="polite"]').filter({ hasText: done }).waitFor({ state: "attached", timeout: 3_000 }).then(() => true, () => false);
    step(`${label} confirms the copy`, confirmed);
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
    const copied = await eventually(clipboard, (text) => text !== "", { timeoutMs: 3_000, what: `${key} on the copy button to write the clipboard` });
    step(`${key} on the focused copy button copies the standard output`, copied === part.output.stdout, `clipboard ${JSON.stringify(copied)}`);
  }

  await page.waitForFunction(() => ![...document.querySelectorAll('[aria-live="polite"]')].some((node) => /copied/i.test(node.textContent ?? "")), null, { timeout: 5_000 });
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
  const copiedSource = await eventually(clipboard, (text) => text !== "", { timeoutMs: 3_000, what: "Copy source to write the clipboard" });
  step("the reopened card still copies the source exactly", copiedSource === part.input.code);

  const browser = context.browser();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await mobile.addCookies(await context.cookies());
  const phone = await mobile.newPage();
  await phone.goto(`${origin}/c/${id}`);
  const phoneCard = phone.locator('[data-tool-name="run_code"]');
  await phoneCard.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 15_000 });
  for (const { label } of channels) {
    const target = phoneCard.getByRole("button", { name: label });
    await target.scrollIntoViewIfNeeded();
    const hits = await target.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      return [[0, 0], [-21.9, -21.9], [21.9, -21.9], [-21.9, 21.9], [21.9, 21.9]].map(([dx, dy]) => document.elementFromPoint(x + dx, y + dy)?.closest("button") === button);
    });
    step(`${label} has a 44 pixel touch area at 390 pixels`, hits.every(Boolean), JSON.stringify(hits));
  }
  const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  step("the card with its copy buttons fits the 390 pixel page", fits);
  await phoneCard.scrollIntoViewIfNeeded();
  await shot("phone", phone);
  await mobile.close();
}
