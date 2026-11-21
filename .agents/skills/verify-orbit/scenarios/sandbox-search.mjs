const runs = [
  { tag: "run-token", name: "a token printed to standard output", query: "gizmowobble7", channel: "standard output" },
  { tag: "run-token-err", name: "a token printed to standard error", query: "kettlewhistle9", channel: "standard error" },
  { tag: "run-token-echo", name: "a token that the reply repeats", query: "echoedtoken42", channel: "standard output and the reply" },
  { tag: "run-js-token", name: "a JavaScript run that prints no token", query: null, channel: "none" },
];

const sources = [
  { index: 0, name: "a token only in Python source", query: "sourceonlytoken5" },
  { index: 3, name: "a token only in JavaScript source", query: "jssourceonlytoken3" },
];

async function hits(page, origin, query) {
  const response = await page.request.get(`${origin}/api/search?q=${encodeURIComponent(query)}`);
  return { status: response.status(), body: response.ok() ? await response.json() : null };
}

export default async function sandboxSearch({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id: chatId } = await (await page.request.post(`${origin}/api/chats`)).json();
  const { id: otherId } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${chatId}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  for (const run of runs) {
    const card = cards.nth(await cards.count());
    await composer.fill(`[qa:${run.tag}]`);
    await composer.press("Enter");
    await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 30_000 });
  }

  const saved = await (await page.request.get(`${origin}/api/chats/${chatId}`)).json();
  const replies = saved.messages.map(({ message }) => message).filter((message) => message.role === "assistant");
  const prompts = saved.messages.map(({ message }) => message).filter((message) => message.role === "user");
  step("no prompt or reply says the output tokens", ![...prompts, ...replies].some((message) => /gizmowobble7|kettlewhistle9/.test(JSON.stringify(message.parts.filter((part) => part.type === "text")))), "a token is in message text");

  for (const [index, run] of runs.entries()) {
    if (!run.query) continue;
    const found = await hits(page, origin, run.query);
    const list = found.body?.hits ?? found.body ?? [];
    step(`${run.name} is found by search`, found.status === 200 && Array.isArray(list) && list.length === 1, `status ${found.status}, ${Array.isArray(list) ? list.length : "?"} hits`);
    const hit = Array.isArray(list) ? list[0] : undefined;
    step(`${run.name} opens the right chat and message`, hit?.chatId === chatId && hit?.messageId === replies[index]?.id && hit?.role === "assistant", `hit ${JSON.stringify(hit && { chatId: hit.chatId, messageId: hit.messageId })}`);
    step(`${run.name} gives one result for ${run.channel}`, Array.isArray(list) && new Set(list.map((entry) => entry.messageId)).size === list.length);
  }

  for (const source of sources) {
    const found = await hits(page, origin, source.query);
    const list = found.body?.hits ?? found.body ?? [];
    step(`${source.name} is found by search`, found.status === 200 && Array.isArray(list) && list.length === 1, `status ${found.status}, ${Array.isArray(list) ? list.length : "?"} hits`);
    const hit = Array.isArray(list) ? list[0] : undefined;
    step(`${source.name} opens the right chat and message`, hit?.chatId === chatId && hit?.messageId === replies[source.index]?.id && hit?.role === "assistant", `hit ${JSON.stringify(hit && { chatId: hit.chatId, messageId: hit.messageId })}`);
  }

  await page.goto(`${origin}/c/${otherId}`);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator("input").fill("gizmowobble7");
  await page.waitForTimeout(500);
  const heading = dialog.getByText("Messages", { exact: true });
  const visible = await heading.isVisible().catch(() => false);
  await shot(visible ? "results" : "before");
  step("the palette shows a Messages result for the output token", visible, "no Messages group");
  if (visible) {
    await dialog.getByText("gizmowobble7").first().click();
    await page.waitForURL(new RegExp(`/c/${chatId}\\?m=${replies[0].id}`), { timeout: 10_000 });
    const target = page.locator(`[data-message-id="${replies[0].id}"]`);
    await target.waitFor({ timeout: 10_000 });
    await target.evaluate((node) => node.scrollIntoView({ block: "center" }));
    step("opening the result shows the message with the run card", (await target.locator('[data-tool-name="run_code"]').count()) === 1);
    await shot("opened");
  }

  await page.goto(`${origin}/c/${chatId}`);
  await page.reload();
  await cards.first().waitFor();
  const again = await hits(page, origin, "gizmowobble7");
  const againList = again.body?.hits ?? again.body ?? [];
  step("the output is still found after the chat is reopened", Array.isArray(againList) && againList.length === 1 && againList[0]?.messageId === replies[0].id);

  await page.goto(`${origin}/c/${otherId}`);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator("input").fill("jssourceonlytoken3");
  await dialog.getByText("jssourceonlytoken3").first().waitFor({ timeout: 5_000 }).catch(() => {});
  const sourceShown = await dialog.getByText("jssourceonlytoken3").first().isVisible().catch(() => false);
  await shot(sourceShown ? "source-results" : "source-before");
  step("the palette shows a Messages result for a token that is only in source", sourceShown && (await dialog.getByText("Messages", { exact: true }).isVisible().catch(() => false)), "no source result");
  if (sourceShown) {
    await dialog.getByText("jssourceonlytoken3").first().click();
    await page.waitForURL(new RegExp(`/c/${chatId}\\?m=${replies[3].id}`), { timeout: 10_000 });
    const target = page.locator(`[data-message-id="${replies[3].id}"]`);
    await target.waitFor({ timeout: 10_000 });
    await target.evaluate((node) => node.scrollIntoView({ block: "center" }));
    step("opening the source result shows the message with the run card", (await target.locator('[data-tool-name="run_code"]').count()) === 1);
    await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
    await shot("source-opened");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/c/${otherId}`);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator("input").fill("kettlewhistle9");
  await dialog.getByText("kettlewhistle9").first().waitFor({ timeout: 5_000 }).catch(() => {});
  step("the phone palette shows the standard error result", await dialog.getByText("kettlewhistle9").first().isVisible().catch(() => false));
  await shot("mobile");
  await dialog.locator("input").fill("sourceonlytoken5");
  await dialog.getByText("sourceonlytoken5").first().waitFor({ timeout: 5_000 }).catch(() => {});
  step("the phone palette shows the source result", await dialog.getByText("sourceonlytoken5").first().isVisible().catch(() => false));
  step("the phone page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot("source-mobile");
}
