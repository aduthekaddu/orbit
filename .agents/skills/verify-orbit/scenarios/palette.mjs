import { eventually } from "../../../../src/lib/eventually.mjs";

export default async function palette({ page, origin, step, shot }) {
  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  const chatUrl = `${origin}/c/${id}`;
  const dialog = page.getByRole("dialog", { name: "Command palette" });

  await page.goto(chatUrl);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  step("Ctrl+K opens the palette", true);
  await page.keyboard.type("Settings");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/settings$/, { timeout: 10_000 }).catch(() => {});
  await dialog.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
  await shot("after-select");
  step("Enter on Settings opens /settings", page.url().endsWith("/settings"), `url is ${page.url()}`);
  step("palette closes after select", !(await dialog.isVisible()), "dialog still visible");

  await page.goto(chatUrl);
  await page.getByRole("textbox").click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA", null, { timeout: 2_000 }).catch(() => {});
  await shot("after-escape");
  step("Esc closes the palette", !(await dialog.isVisible()), "dialog still visible");
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? "none");
  step("focus returns to the composer", focused === "TEXTAREA", `focus is on ${focused}`);

  const composer = page.getByRole("textbox");
  await composer.fill("[qa:plain] quokkanest");
  await composer.press("Enter");
  const replied = await page
    .locator('[data-message-role="assistant"]')
    .getByText("pong", { exact: true })
    .waitFor({ timeout: 30_000 })
    .then(() => true, () => false);
  step("the chat has a message to search", replied);

  const input = dialog.locator("input");
  const noResults = dialog.getByText("No results", { exact: true });
  const searchFailed = dialog.getByText("Could not search", { exact: true });
  const messages = dialog.getByText("Messages", { exact: true });
  const shows = (locator, timeout) => locator.waitFor({ timeout }).then(() => true, () => false);

  await page.route("**/api/search*", (route) => route.abort());
  await composer.click();
  await page.keyboard.press("Control+K");
  await dialog.waitFor({ timeout: 5_000 });
  await input.fill("wombatless");
  const failed = await shows(searchFailed, 5_000);
  await shot("search-failed");
  step("a failed search does not say No results", failed && !(await noResults.isVisible()), failed ? "No results is visible" : "Could not search is not visible");

  await page.unroute("**/api/search*");
  await input.fill("quokkanest");
  const recovered = await shows(messages, 5_000);
  await shot("search-recovered");
  step(
    "a search after a failed one shows the hit and no error",
    failed && recovered && !(await searchFailed.isVisible()),
    !failed ? "the failed search showed no error" : recovered ? "Could not search is still visible" : "no Messages group",
  );

  await page.route("**/api/search*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await input.fill("wombatless");
  const serverError = await shows(searchFailed, 5_000);
  step("a server error says Could not search", serverError && !(await noResults.isVisible()), serverError ? "No results is visible" : "Could not search is not visible");

  await page.unroute("**/api/search*");
  const seenQueries = [];
  let releasePending = () => {};
  const pendingReleased = new Promise((resolve) => {
    releasePending = resolve;
  });
  await page.route("**/api/search*", async (route) => {
    seenQueries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await pendingReleased;
    await route.continue().catch(() => {});
  });
  try {
    await input.fill("wombatness");
    await eventually(() => seenQueries.includes("wombatness"), Boolean, {
      timeoutMs: 5_000,
      what: "the pending search request for wombatness",
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await shot("search-pending");
    step("a pending search does not say No results", !(await noResults.isVisible()) && !(await searchFailed.isVisible()), "No results or Could not search is visible");
    await input.fill("wombatnes");
    await eventually(() => seenQueries.includes("wombatnes"), Boolean, {
      timeoutMs: 5_000,
      what: "the follow-up search request for wombatnes",
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    step("a canceled search does not say Could not search", !(await searchFailed.isVisible()) && !(await noResults.isVisible()), "Could not search or No results is visible");
    releasePending();
    const empty = await shows(noResults, 6_000);
    step("a finished search with no match says No results", empty && !(await searchFailed.isVisible()), empty ? "Could not search is visible" : "No results is not visible");
  } finally {
    releasePending();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
}
