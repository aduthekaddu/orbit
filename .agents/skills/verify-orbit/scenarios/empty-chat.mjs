const STARTERS = ["Make a table", "Explain code", "Summarize", "Brainstorm"];

async function count(locator) {
  return locator.count().catch(() => 0);
}

export default async function emptyChat({ page, origin, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  const chatUrl = `${origin}/c/${id}`;
  await page.goto(chatUrl);
  await page.getByRole("textbox").waitFor({ timeout: 10_000 });

  const nav = page.locator("aside nav");
  step("sidebar shows Untitled for the new chat", (await count(nav.getByRole("link", { name: "Untitled" }))) > 0, "no Untitled link");
  step("sidebar has no chat named New chat", (await count(nav.getByRole("link", { name: "New chat" }))) === 0, "a chat link says New chat");

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor({ timeout: 5_000 });
  step("palette lists the new chat as Untitled", (await count(palette.getByRole("option", { name: "Untitled" }))) > 0, "no Untitled option");
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden", timeout: 2_000 });

  const composer = page.getByPlaceholder("Ask anything");
  step("composer placeholder is Ask anything", (await count(composer)) === 1, "no Ask anything placeholder");

  const found = [];
  for (const label of STARTERS) {
    if ((await count(page.getByRole("button", { name: label, exact: true }))) === 1) found.push(label);
  }
  step("four starters show", found.length === 4, `found ${found.join(", ") || "none"}`);
  await shot("starters");

  if (found.includes("Make a table")) {
    await page.getByRole("button", { name: "Make a table", exact: true }).click();
    await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement && document.activeElement.value !== "", null, { timeout: 5_000 }).catch(() => {});
    const state = await page.evaluate(() => {
      const node = document.activeElement;
      return node instanceof HTMLTextAreaElement
        ? { value: node.value, caret: node.selectionStart, focused: true }
        : { value: "", caret: -1, focused: false };
    });
    step("Make a table fills the composer", state.value === "Make a table comparing ", `value "${state.value}"`);
    step("composer has focus with the caret at the end", state.focused && state.caret === state.value.length, JSON.stringify(state));
    step("starter does not send", (await count(page.locator("[data-turn-id]"))) === 0 && page.url() === chatUrl, "a message was sent");
    await shot("filled");
  }

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await page.context().cookies());
  const mobile = await phone.newPage();
  await mobile.goto(chatUrl);
  await mobile.getByRole("textbox").waitFor({ timeout: 10_000 });
  await mobile.getByRole("button", { name: STARTERS[0], exact: true }).waitFor({ timeout: 15_000 });
  const heights = [];
  for (const label of STARTERS) {
    const box = await mobile.getByRole("button", { name: label, exact: true }).boundingBox({ timeout: 2_000 }).catch(() => null);
    heights.push(box ? Math.round(box.height) : 0);
  }
  step("phone header shows Untitled", (await count(mobile.getByRole("heading", { name: "Untitled" }))) === 1, "header is not Untitled");
  step("starters are at least 44px tall on a phone", heights.every((height) => height >= 44), `heights ${heights.join(", ")}`);
  await shot("phone-390x844", mobile);
  await phone.close();
}
