export default async function sandboxFailure({ page, origin, useProvider, step, shot }) {
  await useProvider();
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
