import { eventually } from "../../../../src/lib/eventually.mjs";
const runs = [
  { tag: "run-color", name: "colored output", stdout: "red\n", stderr: "warn\n" },
  { tag: "run-osc", name: "title, link, and cursor sequences", stdout: "click done\n", stderr: null },
  { tag: "run-cut", name: "a color code that another escape interrupts", stdout: "red\n", stderr: null },
  { tag: "run-html", name: "HTML-looking output", stdout: "<img src=x onerror=alert(1)>\n", stderr: null },
];

async function inspect(card) {
  return card.evaluate((node) => {
    const text = (selector) => node.querySelector(selector)?.textContent ?? null;
    return {
      stdout: text("[data-code-stdout]"),
      stderr: text("[data-code-stderr]"),
      links: node.querySelectorAll("a").length,
      images: node.querySelectorAll("img").length,
      html: node.innerHTML,
    };
  });
}

async function check(step, card, run, when, page) {
  const seen = await inspect(card);
  const label = `${run.name} ${when}`;
  step(`${label} shows the plain text in standard output`, seen.stdout === run.stdout, `stdout ${JSON.stringify(seen.stdout)}`);
  if (run.stderr !== null) step(`${label} shows the plain text in standard error`, seen.stderr === run.stderr, `stderr ${JSON.stringify(seen.stderr)}`);
  step(`${label} has no escape or control character on the card`, !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(seen.html), "found a control character");
  step(`${label} shows no escape fragment`, !/\[31|\[1;33m|\]0;|\]8;;|31red/.test(`${seen.stdout} ${seen.stderr}`), `${JSON.stringify(seen.stdout)} ${JSON.stringify(seen.stderr)}`);
  step(`${label} adds no link or image to the card`, seen.links === 0 && seen.images === 0, `${seen.links} links, ${seen.images} images`);
  step(`${label} does not set the page title`, !(await page.title()).includes("pwned"), `title ${JSON.stringify(await page.title())}`);
}

export default async function sandboxEscapes({ page, origin, useProvider, step, shot }) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await useProvider();
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  for (const run of runs) {
    const card = cards.nth(await cards.count());
    await composer.fill(`[qa:${run.tag}]`);
    await composer.press("Enter");
    await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 30_000 });
    await card.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await check(step, card, run, "on desktop", page);
    await shot(run.tag);
  }

  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const colored = cards.first();
  for (const [label, expected] of [["Copy standard output", "red\n"], ["Copy standard error", "warn\n"]]) {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await colored.getByRole("button", { name: label }).click();
    const copied = await eventually(clipboard, (text) => text !== "", { timeoutMs: 3_000, what: `${label} to write the clipboard` });
    step(`${label} copies the text without the sequences`, copied === expected, `clipboard ${JSON.stringify(copied)}`);
  }

  await page.reload();
  await cards.nth(runs.length - 1).waitFor();
  for (const [index, run] of runs.entries()) await check(step, cards.nth(index), run, "after reload", page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.innerWidth === 390);
  step("the page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await cards.first().evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot("mobile");
}
