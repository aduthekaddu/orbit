export default async function composerReadiness({ page, origin, step, shot }) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const composer = page.getByPlaceholder("Ask anything");
  const chunks = `${origin}/_next/static/chunks/**`;
  const scripts = Promise.withResolvers();
  const holdScripts = async (route) => {
    if (route.request().resourceType() !== "script") return route.fallback();
    await scripts.promise;
    await route.continue();
  };

  await page.route(chunks, holdScripts);
  try {
    await page.goto(`${origin}/c/${id}`, { waitUntil: "commit" });
    await composer.waitFor({ state: "visible" });
    step("the composer is disabled while chat scripts are held", await composer.isDisabled(), "the composer accepts input");
    await shot("composer-before-scripts");
  } finally {
    scripts.resolve();
  }

  await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "Ask anything");
  await composer.fill("[qa:artifact-html]");
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${origin}/api/chat` && response.request().method() === "POST"),
    composer.press("Enter"),
  ]);
  step("the first Enter sends the prompt", response.ok(), `POST /api/chat returned ${response.status()}`);
  const reply = page.locator('[data-message-role="assistant"]').last();
  await reply.getByRole("button", { name: /^Open / }).waitFor();
  step("the first reply appears", true);
}
