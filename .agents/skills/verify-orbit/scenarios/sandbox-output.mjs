export default async function sandboxOutput({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  for (const [scenario, marker] of [["run-timeout", "before-timeout"], ["run-oom", "before-oom"]]) {
    const card = cards.nth(await cards.count());
    await composer.fill(`[qa:${scenario}]`);
    await composer.press("Enter");
    await card.locator('[data-tool-status="failed"]').waitFor({ timeout: 25_000 });
    step(`${scenario} keeps output printed before termination`, await card.locator('[data-code-stdout]').textContent() === `${marker}\n`);
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    await card.scrollIntoViewIfNeeded();
    await shot(scenario);
  }
  await page.reload();
  await cards.last().waitFor();
  step("printed output survives reload after timeout and memory kill", await cards.first().locator('[data-code-stdout]').textContent() === "before-timeout\n" && await cards.last().locator('[data-code-stdout]').textContent() === "before-oom\n");
  await shot("reloaded");
}
