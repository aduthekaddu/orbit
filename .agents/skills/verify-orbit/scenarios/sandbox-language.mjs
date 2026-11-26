import { waitForSpinningProgram } from "../sandbox-program.mjs";

const runs = [
  { tag: "run-python", name: "a Python run", language: "Python", status: "succeeded" },
  { tag: "run-js", name: "a JavaScript run", language: "JavaScript", status: "succeeded" },
  { tag: "run-js-exit", name: "a failed JavaScript run", language: "JavaScript", status: "failed" },
  { tag: "run-ruby", name: "a rejected Ruby call", language: null, status: "failed" },
  { tag: "run-spin", name: "a stopped Python run", language: "Python", status: "cancelled", stop: true },
];

async function inspect(card) {
  return card.evaluate((node) => {
    const header = node.firstElementChild;
    const spans = [...header.querySelectorAll("span")];
    const tag = spans.find((span) => /^(Python|JavaScript)$/.test(span.textContent?.trim() ?? ""));
    const box = tag?.getBoundingClientRect();
    const head = header.getBoundingClientRect();
    const surface = (element) => {
      for (let current = element; current; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
      }
      return null;
    };
    return {
      language: tag?.textContent?.trim() ?? null,
      title: spans[0]?.textContent?.trim() ?? null,
      tagInside: box ? box.left >= head.left && box.right <= head.right && Math.round(tag.scrollWidth) <= Math.round(box.width) : null,
      headerFits: header.scrollWidth <= header.clientWidth + 1,
      sourceColor: node.querySelector("pre") ? surface(node.querySelector("pre")) : null,
      outputColor: node.querySelector("[data-code-stdout], [data-code-stderr]") ? surface(node.querySelector("[data-code-stdout], [data-code-stderr]")) : null,
    };
  });
}

async function check(step, card, run, when) {
  const seen = await inspect(card);
  const label = `${run.name} ${when}`;
  step(`${label} shows ${run.language ?? "no language"} in the header`, seen.language === run.language, `language ${JSON.stringify(seen.language)}`);
  if (run.language) step(`${label} keeps its header on one line`, seen.headerFits && seen.tagInside === true, `fits ${seen.headerFits}, tag inside ${seen.tagInside}`);
  return seen;
}

export default async function sandboxLanguage({ page, origin, useProvider, step, shot }) {
  await useProvider();
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  const starts = [];
  for (const run of runs) {
    starts.push(await cards.count());
    const card = cards.nth(starts.at(-1));
    await composer.fill(`[qa:${run.tag}]`);
    await composer.press("Enter");
    if (run.stop) {
      await card.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
      await check(step, card, run, "while running");
      await card.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await shot("running");
      await waitForSpinningProgram();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
    }
    await card.locator(`[data-tool-status="${run.status}"]`).waitFor({ timeout: 40_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 40_000 });
    await card.scrollIntoViewIfNeeded();
    await check(step, card, run, run.stop ? "after Stop" : "on desktop");
  }
  const rejected = runs.findIndex((run) => run.language === null);
  let bare = starts[rejected + 1] > starts[rejected];
  for (let index = starts[rejected]; index < starts[rejected + 1]; index += 1) bare = bare && (await inspect(cards.nth(index))).language === null;
  step("every card of the rejected Ruby call shows no language", bare, `${starts[rejected + 1] - starts[rejected]} cards`);
  const python = await inspect(cards.first());
  step("the source and the output sit on different surfaces", python.sourceColor !== null && python.outputColor !== null && python.sourceColor !== python.outputColor, `source ${python.sourceColor}, output ${python.outputColor}`);
  await cards.first().evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot("python");
  await cards.nth(1).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot("javascript");

  await page.reload();
  await cards.nth(starts.at(-1)).waitFor();
  for (const [index, run] of runs.entries()) await check(step, cards.nth(starts[index]), run, "after reload");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.innerWidth === 390);
  step("the page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  for (const [index, run] of runs.entries()) {
    const card = cards.nth(starts[index]);
    await card.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await check(step, card, run, "at 390 pixels");
    if (run.tag === "run-js-exit") await shot("mobile-javascript");
  }
}
