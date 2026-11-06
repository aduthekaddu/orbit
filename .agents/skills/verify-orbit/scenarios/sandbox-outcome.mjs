import { execFileSync } from "node:child_process";

const containerRunning = () => execFileSync("docker", ["ps", "--filter", "label=orbit.sandbox=true", "--filter", "status=running", "--format", "{{.ID}}"], { encoding: "utf8" }).trim() !== "";

const runs = [
  { tag: "run-pass", name: "a success", status: "succeeded", outcome: /^Exit 0$/ },
  { tag: "run-exit", name: "a nonzero exit", status: "failed", outcome: /^Exit 3$/ },
  { tag: "run-spin", name: "a timeout", status: "failed", outcome: /^Timed out after \d+(\.\d)? s$/, single: true },
  { tag: "run-oom", name: "a memory kill", status: "failed", outcome: /^Killed \(exit 137\)$/ },
  { tag: "run-spin", name: "a cancelled run", status: "cancelled", outcome: /^Stopped after \d+(\.\d)? s$/, single: true, stop: true },
];

async function inspect(card) {
  return card.evaluate((node) => {
    const lead = [...node.querySelectorAll("span")].find((span) => /^(Exit|Timed out|Killed|Stopped)/.test(span.textContent?.trim() ?? ""));
    const row = lead?.parentElement ?? null;
    return {
      header: node.querySelector("[data-tool-status]")?.textContent?.trim() ?? null,
      spans: row ? [...row.querySelectorAll("span")].map((span) => span.textContent?.trim() ?? "") : [],
      row: row ? [...row.querySelectorAll("span")].map((span) => span.textContent?.trim() ?? "").join(" ") : "",
      text: node.innerText,
    };
  });
}

async function check(step, card, run, when) {
  const seen = await inspect(card);
  const label = `${run.name} ${when}`;
  const primary = seen.spans[0] ?? "";
  step(`${label} states one outcome`, seen.spans.filter((span) => /^(Exit|Timed out|Killed|Stopped)/.test(span)).length === 1, `result ${JSON.stringify(seen.spans)}`);
  step(`${label} words its outcome as expected`, run.outcome.test(primary), `primary ${JSON.stringify(primary)}`);
  step(`${label} keeps its header status`, seen.header === { succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" }[run.status], `header ${JSON.stringify(seen.header)}`);
  step(`${label} does not repeat the status in the result`, !/Failed|Succeeded|Cancelled/.test(seen.row), `row ${JSON.stringify(seen.row)}`);
  step(`${label} shows no raw milliseconds over 999`, !/\b\d{4,} ms\b/.test(seen.row), `row ${JSON.stringify(seen.row)}`);
  step(`${label} does not say "Exit killed"`, !/Exit killed/.test(seen.text), "found Exit killed");
  if (run.single) step(`${label} shows its duration once`, (seen.row.match(/\d+(\.\d)? (ms|s)\b/g) ?? []).length === 1, `row ${JSON.stringify(seen.row)}`);
  return seen;
}

export default async function sandboxOutcome({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  const rows = [];
  for (const run of runs) {
    const card = cards.nth(await cards.count());
    await composer.fill(`[qa:${run.tag}]`);
    await composer.press("Enter");
    if (run.stop) {
      await card.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
      const started = Date.now();
      while (!containerRunning() && Date.now() - started < 20_000) await page.waitForTimeout(50);
      await page.waitForTimeout(2_000);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
    }
    await card.locator(`[data-tool-status="${run.status}"]`).waitFor({ timeout: 40_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 40_000 });
    await card.scrollIntoViewIfNeeded();
    const seen = run.stop ? await inspect(card) : await check(step, card, run, "on desktop");
    if (run.stop) step(`${run.name} on desktop shows Cancelled in its header`, seen.header === "Cancelled", `header ${JSON.stringify(seen.header)}`);
    rows.push(seen);
    console.log(`${run.name}: header ${JSON.stringify(seen.header)}, result ${JSON.stringify(seen.row)}`);
    await shot(run.tag === "run-spin" && run.stop ? "cancelled" : run.tag);
  }

  await page.reload();
  await cards.nth(runs.length - 1).waitFor();
  for (const [index, run] of runs.entries()) {
    const card = cards.nth(index);
    const seen = await check(step, card, run, "after reload");
    step(`${run.name} after reload keeps the same result text`, run.stop ? seen.header === rows[index].header : seen.row === rows[index].row && seen.header === rows[index].header, `before ${JSON.stringify(rows[index].row)}, after ${JSON.stringify(seen.row)}`);
    step(`${run.name} after reload keeps its status role`, (await card.getByRole("status").count()) === 1);
  }
  await cards.nth(2).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot("reloaded");
  await cards.nth(runs.length - 1).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot("cancelled-reloaded");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  step("the page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  for (const [index, run] of runs.entries()) {
    const card = cards.nth(index);
    await card.evaluate((node) => node.scrollIntoView({ block: "center" }));
    const inside = await card.getByText(/^(Exit|Timed out|Killed|Stopped)/).first().evaluate((node) => {
      const box = node.parentElement.getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth;
    });
    step(`${run.name} keeps its result inside the 390 pixel page`, inside);
    if (run.name === "a timeout") await shot("mobile-timeout");
  }
}
