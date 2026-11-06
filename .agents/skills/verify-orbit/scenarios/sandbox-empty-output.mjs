const runs = [
  { tag: "run-pass", name: "a silent success", status: "succeeded", source: "pass", stdout: false, stderr: false, exit: /Exit 0/ },
  { tag: "run-python", name: "a success with standard output only", status: "succeeded", source: "print(1+1)", stdout: true, stderr: false, exit: /Exit 0/ },
  { tag: "run-escape", name: "a failure with standard error only", status: "failed", source: "urllib.request", stdout: false, stderr: true, exit: /Exit 1/ },
  { tag: "run-exit", name: "a silent nonzero exit", status: "failed", source: "sys.exit(3)", stdout: false, stderr: false, exit: /Exit 3/ },
  { tag: "run-spin", name: "a silent timeout", status: "failed", source: "while True: pass", stdout: false, stderr: false, exit: /Timed out/ },
  { tag: "run-blank", name: "a run that prints only blank lines", status: "succeeded", source: "print()", stdout: false, stderr: false, exit: /Exit 0/ },
];

async function inspect(card) {
  return card.evaluate((node) => {
    const wells = [...node.querySelectorAll("[data-code-stdout], [data-code-stderr]")];
    const labels = [...node.querySelectorAll("p")].map((p) => p.textContent?.trim());
    const exit = [...node.querySelectorAll("span")].find((span) => /^(Exit|Timed out|Out of memory|Killed|Stopped)/.test(span.textContent ?? ""));
    const row = exit?.parentElement ? [...exit.parentElement.querySelectorAll("span")].map((span) => span.textContent ?? "").join(" ") : "";
    const duration = /\d+(\.\d)? (ms|s)\b/.exec(row)?.[0];
    return {
      stdout: node.querySelectorAll("[data-code-stdout]").length,
      stderr: node.querySelectorAll("[data-code-stderr]").length,
      emptyWells: wells.filter((well) => !well.textContent?.trim()).length,
      stdoutLabel: labels.includes("stdout"),
      stderrLabel: labels.includes("stderr"),
      copySource: [...node.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Copy source"),
      exit: exit?.textContent ?? null,
      duration: duration ?? null,
      text: node.innerText,
      height: Math.round(node.getBoundingClientRect().height),
    };
  });
}

async function check(step, card, run, when) {
  const seen = await inspect(card);
  const label = `${run.name} ${when}`;
  step(`${label} has no empty output well`, seen.emptyWells === 0, `${seen.emptyWells} empty wells`);
  step(`${label} ${run.stdout ? "shows" : "hides"} the standard output well`, seen.stdout === (run.stdout ? 1 : 0) && seen.stdoutLabel === run.stdout, `wells ${seen.stdout}, label ${seen.stdoutLabel}`);
  step(`${label} ${run.stderr ? "shows" : "hides"} the standard error well`, seen.stderr === (run.stderr ? 1 : 0) && seen.stderrLabel === run.stderr, `wells ${seen.stderr}, label ${seen.stderrLabel}`);
  step(`${label} keeps its source`, seen.copySource && seen.text.includes(run.source), "source missing");
  step(`${label} keeps its exit status and duration`, run.exit.test(seen.exit ?? "") && seen.duration !== null, `exit ${JSON.stringify(seen.exit)}, duration ${JSON.stringify(seen.duration)}`);
  return seen;
}

export default async function sandboxEmptyOutput({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  const cards = page.locator('[data-tool-name="run_code"]');
  const heights = [];
  for (const run of runs) {
    const card = cards.nth(await cards.count());
    await composer.fill(`[qa:${run.tag}]`);
    await composer.press("Enter");
    await card.locator(`[data-tool-status="${run.status}"]`).waitFor({ timeout: 40_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 40_000 });
    await card.scrollIntoViewIfNeeded();
    const seen = await check(step, card, run, "on desktop");
    heights.push(`${run.tag} ${seen.height}px`);
    if (run.tag === "run-pass" || run.tag === "run-exit" || run.tag === "run-spin" || run.tag === "run-blank") await shot(run.tag);
  }
  console.log(`card heights ${heights.join(", ")}`);

  await page.reload();
  await cards.nth(runs.length - 1).waitFor();
  for (const [index, run] of runs.entries()) {
    await check(step, cards.nth(index), run, "after reload");
  }
  await cards.first().scrollIntoViewIfNeeded();
  await shot("reloaded");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  step("the page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  for (const [index, run] of runs.entries()) {
    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded();
    await check(step, card, run, "at 390 pixels");
    const inside = await card.getByText(/^(Exit|Timed out|Out of memory|Killed|Stopped)/).first().evaluate((node) => {
      const box = node.parentElement.getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth;
    });
    step(`${run.name} keeps its result inside the 390 pixel page`, inside);
    if (run.tag === "run-pass") await shot("mobile-pass");
  }
}
