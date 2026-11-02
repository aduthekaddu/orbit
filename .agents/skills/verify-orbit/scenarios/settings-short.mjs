export default async function settingsShort({ page, origin, step, shot }) {
  await page.setViewportSize({ width: 390, height: 568 });
  await page.goto(`${origin}/settings`);

  const save = page.getByRole("button", { name: "Save" });
  await save.waitFor({ timeout: 10_000 });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  const inView = Boolean(box && box.y >= 0 && box.y + box.height <= 568 && box.x >= 0 && box.x + box.width <= 390);
  step("Save scrolls into the 390x568 viewport", inView, `box ${JSON.stringify(box)}`);
  const onTop = box
    ? await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent?.trim() ?? "none",
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      )
    : "none";
  step("nothing covers Save", onTop === "Save", `top element is ${onTop}`);
  await shot("save-visible");

  await save.click({ timeout: 5_000 });
  const saved = page.getByText("Saved", { exact: true });
  const shown = await saved.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  step("clicking Save shows Saved", shown, "no Saved text");
}
