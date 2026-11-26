export default async function sandboxCopyOverlap({ page, origin, useProvider, step, shot }) {
  await useProvider();
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
    const last = text.data.trimEnd().length;
    const range = document.createRange();
    range.setStart(text, last - 3);
    range.setEnd(text, last);
    const end = range.getBoundingClientRect();
    const covered = button.getBoundingClientRect();
    const across = Math.min(end.right, covered.right) - Math.max(end.left, covered.left);
    const down = Math.min(end.bottom, covered.bottom) - Math.max(end.top, covered.top);
    return { across: Math.round(across), down: Math.round(down), overlaps: across > 0 && down > 0 };
  });
  step("the end of a long first line stays clear of the copy button", !hidden.overlaps, `text and button overlap by ${hidden.across} by ${hidden.down} pixels`);
  await shot("scrolled-right");

  const mobile = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await mobile.addCookies(await page.context().cookies());
  const phone = await mobile.newPage();
  await phone.goto(`${origin}/c/${id}`);
  const phoneCard = phone.locator('[data-tool-name="run_code"]');
  await phoneCard.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 15_000 });
  await phoneCard.getByRole("region", { name: "Standard output horizontal scroll", exact: true }).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const tapped = await phoneCard.evaluate((element) => {
    const text = element.querySelector("[data-code-stdout] code").firstChild;
    const last = text.data.trimEnd().length;
    const range = document.createRange();
    range.setStart(text, last - 1);
    range.setEnd(text, last);
    const box = range.getBoundingClientRect();
    return document.elementFromPoint(box.right - 1, box.top + box.height / 2)?.closest("button")?.getAttribute("aria-label") ?? null;
  });
  step("a tap on the right edge of the last character of the first line does not land on the copy button", tapped === null, `the tap lands on ${tapped}`);
  await shot("phone-scrolled-right", phone);
  await mobile.close();
}
