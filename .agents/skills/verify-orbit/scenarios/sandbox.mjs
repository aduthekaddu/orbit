export default async function sandbox({ page, origin, step, shot }) {
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
  step("Python card shows source, stdout 2, exit 0, and duration", (await python.innerText()).includes("print(1+1)") && await python.locator('[data-code-stdout]').innerText() === "2" && (await python.innerText()).includes("Exit 0") && /\d+ ms/.test(await python.innerText()));
  step("Python card succeeds", await python.locator('[data-tool-status="succeeded"]').count() === 1);
  await shot("python");
  await page.reload();
  await cards.first().waitFor();
  step("code and output survive reload", (await cards.first().innerText()).includes("print(1+1)") && await cards.first().locator('[data-code-stdout]').innerText() === "2");
  await page.setViewportSize({ width: 390, height: 844 });
  await cards.first().scrollIntoViewIfNeeded();
  await shot("mobile");
  step("the 390 by 844 card fits the page", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 800 });
  await composer.fill("[qa:run-escape]");
  await composer.press("Enter");
  await cards.last().locator('[data-tool-status="failed"]').waitFor({ timeout: 30_000 });
  step("network escape shows a failed card with a network error", /Network is unreachable|network is unreachable/.test(await cards.last().locator('[data-code-stderr]').innerText()));
  await shot("escape");
}
