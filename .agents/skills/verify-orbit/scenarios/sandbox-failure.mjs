export default async function sandboxFailure({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  await composer.fill("[qa:run-python]");
  await composer.press("Enter");
  const card = page.locator('[data-tool-name="run_code"]').first();
  await card.locator('[data-tool-status="failed"]').waitFor({ timeout: 20_000 });
  step("invalid Docker configuration shows its cause", /configuration|DOCKER_HOST/.test(await card.innerText()));
  await shot("configuration");
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await page.reload();
  await card.locator('[data-tool-status="failed"]').waitFor();
  step("the configuration error survives reload", /configuration|DOCKER_HOST/.test(await card.innerText()));
  await shot("configuration-reloaded");
}
