export default async function sandboxCopyOverlap({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const card = page.locator('[data-tool-name="run_code"]');
  await composer.fill("[qa:run-wide]");
  await composer.press("Enter");
  await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 25_000 });

  const scroller = card.getByRole("region", { name: "Standard output horizontal scroll", exact: true });
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const hidden = await card.evaluate((element) => {
    const code = element.querySelector("[data-code-stdout] code");
    const button = element.querySelector('button[aria-label="Copy standard output"]');
    const text = code.firstChild;
    const range = document.createRange();
    range.setStart(text, text.length - 3);
    range.setEnd(text, text.length);
    const end = range.getBoundingClientRect();
    const covered = button.getBoundingClientRect();
    const across = Math.min(end.right, covered.right) - Math.max(end.left, covered.left);
    const down = Math.min(end.bottom, covered.bottom) - Math.max(end.top, covered.top);
    return { across: Math.round(across), down: Math.round(down), overlaps: across > 0 && down > 0 };
  });
  step("the end of a long first line stays clear of the copy button", !hidden.overlaps, `text and button overlap by ${hidden.across} by ${hidden.down} pixels`);
  await shot("scrolled-right");
}
