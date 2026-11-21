export default async function sandbox({ page, origin, step, shot }) {
  const settings = await page.request.put(`${origin}/api/settings`, {
    data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" },
  });
  if (!settings.ok()) throw new Error(`mock settings returned ${settings.status()}`);
  const response = await page.request.post(`${origin}/api/chats`);
  const { id } = await response.json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  await composer.fill("[qa:run-python]");
  await composer.press("Enter");
  await page.locator('[data-message-role="assistant"]').last().getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 30_000 });
  if (!step("Python creates a run_code card", await cards.count() === 1, "run_code card is missing")) {
    await shot("missing");
    return;
  }
  const python = cards.first();
  const pythonText = await python.innerText();
  step("Python card shows source, stdout 2, exit 0, and duration",
    pythonText.includes("print(1+1)") &&
    await python.locator('[data-code-stdout]').textContent() === "2\n" &&
    /\bExit 0\s+(?:\d+ ms|\d+\.\d s)\b/.test(pythonText));
  step("Python card succeeds", await python.locator('[data-tool-status="succeeded"]').count() === 1);
  await shot("python");
  await page.reload();
  await cards.first().waitFor();
  step("code and output survive reload", (await cards.first().innerText()).includes("print(1+1)") && await cards.first().locator('[data-code-stdout]').textContent() === "2\n");
  await page.setViewportSize({ width: 390, height: 844 });
  await cards.first().scrollIntoViewIfNeeded();
  await shot("mobile");
  step("the 390 by 844 card fits the page", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 800 });
  await composer.fill("[qa:run-escape]");
  await composer.press("Enter");
  await cards.last().locator('[data-tool-status="failed"]').waitFor({ timeout: 30_000 });
  step("network escape shows a failed card with a network error", /Network is unreachable|network is unreachable/.test(await cards.last().locator('[data-code-stderr]').innerText()));
  await page.setViewportSize({ width: 1280, height: 1800 });
  await cards.last().scrollIntoViewIfNeeded();
  await shot("escape");
}
