export default async function threadMap({ page, origin, step, shot }) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  for (const [index, prompt] of ["[qa:plain] one", "[qa:plain] two", "[qa:plain] three"].entries()) {
    await composer.fill(prompt);
    await composer.press("Enter");
    await page.locator('[data-message-role="assistant"]').nth(index).getByText("pong", { exact: true }).waitFor({ timeout: 30_000 });
  }
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 10_000 });
  const turnIds = await page.locator("[data-turn-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-turn-id")));
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      return { tag: element?.tagName ?? "", turnId: element?.getAttribute("data-turn-id") ?? null };
    });

  const typed = "first line\nsecond line";
  await composer.click();
  await page.keyboard.type("first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForTimeout(700);
  const inComposer = await focused();
  const text = await composer.inputValue();
  await shot("composer");
  step(
    "Alt+Up in the composer keeps focus in the composer",
    inComposer.tag === "TEXTAREA" && text === typed,
    `focus=${JSON.stringify(inComposer)} text=${JSON.stringify(text)}`,
  );

  await composer.evaluate((element) => element.blur());
  const onPage = await focused();
  const currentIndex = await page
    .locator('nav[aria-label="Prompts in this chat"] ul button')
    .evaluateAll((buttons) => buttons.findIndex((button) => button.getAttribute("aria-current") === "location"));
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForTimeout(700);
  const afterPage = await focused();
  await shot("page");
  step(
    "Alt+Up on the page moves focus to the previous prompt",
    onPage.tag !== "TEXTAREA" && currentIndex > 0 && afterPage.turnId === turnIds[currentIndex - 1],
    `before=${JSON.stringify(onPage)} after=${JSON.stringify(afterPage)} currentIndex=${currentIndex} prompts=${JSON.stringify(turnIds)}`,
  );
}
