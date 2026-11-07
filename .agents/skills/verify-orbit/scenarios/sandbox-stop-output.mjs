import { execFileSync } from "node:child_process";

const cases = [
  { scenario: "run-timeout", printed: "before-timeout\n" },
  { scenario: "run-spin", printed: "" },
];

const containerRunning = () => execFileSync("docker", ["ps", "--filter", "label=orbit.sandbox=true", "--filter", "status=running", "--format", "{{.ID}}"], { encoding: "utf8" }).trim() !== "";

// What a person sees on the card: header, the outcome line with its duration, and the output wells.
const inspect = (card) => card.evaluate((node) => {
  const lead = [...node.querySelectorAll("span")].find((span) => span.textContent?.trim() === "Stopped");
  return {
    header: node.querySelector("[data-tool-status]")?.textContent?.trim() ?? null,
    row: lead ? [...lead.parentElement.querySelectorAll("span")].map((span) => span.textContent?.trim()).join(" ") : null,
    stdout: node.querySelector("[data-code-stdout]")?.textContent ?? null,
    stderr: node.querySelector("[data-code-stderr]")?.textContent ?? null,
  };
});

async function startAndStop(page, card, tag) {
  const composer = page.getByPlaceholder("Ask anything");
  await composer.fill(`[qa:${tag}]`);
  await composer.press("Enter");
  await card.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
  const started = Date.now();
  while (!containerRunning() && Date.now() - started < 20_000) await page.waitForTimeout(50);
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await card.locator('[data-tool-status="cancelled"]').waitFor({ timeout: 8_000 });
}

export default async function sandboxStopOutput({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const card = page.locator('[data-tool-name="run_code"]');
  for (const { scenario, printed } of cases) {
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder("Ask anything");
    await startAndStop(page, card, scenario);
    step(`${scenario} Stop turns the running card to Cancelled`, true);

    // Type right after Stop. The saved result reaches the live card a moment later and must leave the draft alone.
    const draft = `draft typed after Stop (${scenario})`;
    await composer.fill(draft);
    const messagesBefore = await page.locator("[data-message-role]").count();
    const landed = await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    step(`${scenario} live card shows the Stopped line without a reload`, landed, "the live card never showed a Stopped line");
    const live = await inspect(card);
    console.log(`${scenario} live card ${JSON.stringify(live)}`);
    step(`${scenario} live card keeps Cancelled in its header`, live.header === "Cancelled", `header ${JSON.stringify(live.header)}`);
    step(`${scenario} live card ${printed === "" ? "shows no output well" : "shows the output printed before Stop"}`, printed === "" ? live.stdout === null && live.stderr === null : live.stdout === printed, `stdout ${JSON.stringify(live.stdout)} stderr ${JSON.stringify(live.stderr)}`);
    await page.waitForTimeout(500);
    step(`${scenario} keeps the draft typed after Stop`, (await composer.inputValue()) === draft, `composer holds ${JSON.stringify(await composer.inputValue())}`);
    step(`${scenario} keeps the same messages and branch`, (await page.locator("[data-message-role]").count()) === messagesBefore && (await page.locator("[data-branch-picker]").count()) === 0, `messages ${messagesBefore} then ${await page.locator("[data-message-role]").count()}`);
    await card.scrollIntoViewIfNeeded();
    await shot(`${scenario}-live`);

    let part;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const body = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
      const reply = body.messages.map(({ message }) => message).find((message) => message.role === "assistant");
      part = reply?.parts.find((entry) => entry.type === "tool-run_code");
      if (part) break;
      await page.waitForTimeout(250);
    }
    console.log(`${scenario} saved part state=${part?.state} stdout=${JSON.stringify(part?.output?.stdout)} cancelled=${part?.output?.cancelled} errorText=${JSON.stringify(part?.errorText)}`);
    step(`${scenario} saves the output collected before Stop`, part?.state === "output-available" && part.output.stdout === printed && part.output.cancelled === true, `state ${part?.state}, output ${JSON.stringify(part?.output)}`);

    await page.reload();
    await card.locator('[data-tool-status="cancelled"]').waitFor({ timeout: 15_000 });
    const wells = card.locator("[data-code-stdout]");
    const stdout = (await wells.count()) > 0 ? await wells.first().textContent() : null;
    const text = (await card.innerText()).replace(/\s+/g, " ");
    step(`${scenario} reopened card is Cancelled and shows its source`, text.includes("while True: pass") && !text.includes("Failed"), text.slice(0, 160));
    step(`${scenario} reopened card ${printed === "" ? "shows no output well" : "shows the saved output"}`, printed === "" ? (await card.locator("[data-code-stdout], [data-code-stderr]").count()) === 0 : stdout === printed, `stdout was ${JSON.stringify(stdout)}`);
    const reopened = await inspect(card);
    step(`${scenario} reopened card matches the live card`, JSON.stringify(reopened) === JSON.stringify(live), `live ${JSON.stringify(live)} reopened ${JSON.stringify(reopened)}`);
    await card.scrollIntoViewIfNeeded();
    await shot(`${scenario}-stopped`);

    await page.waitForTimeout(2_500);
    const left = execFileSync("docker", ["ps", "-a", "--filter", "label=orbit.sandbox=true", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
    step(`${scenario} leaves no sandbox container`, left === "", left);
  }

  // Regenerate a stopped run and stop it again, then switch between the two versions. Both keep their result.
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  await startAndStop(page, card, "run-spin");
  await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  const regenerate = page.getByRole("button", { name: "Regenerate", exact: true });
  await regenerate.waitFor({ timeout: 15_000 });
  await regenerate.click();
  await card.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
  const started = Date.now();
  while (!containerRunning() && Date.now() - started < 20_000) await page.waitForTimeout(50);
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await card.locator('[data-tool-status="cancelled"]').waitFor({ timeout: 8_000 });
  const picker = page.locator('[data-message-role="assistant"] [data-branch-picker]');
  const second = await picker.getByText("2 / 2", { exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  step("regenerate after Stop shows the 2 / 2 picker", second, "no 2 / 2 picker");
  const secondLanded = await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  step("the second version shows its Stopped line without a reload", secondLanded, "no Stopped line on the second version");
  if (second) {
    await picker.getByRole("button", { name: "Previous", exact: true }).click();
    const firstShown = await picker.getByText("1 / 2", { exact: true }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const first = await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    step("Previous opens the first version with its Stopped line", firstShown && first, `picker ${firstShown}, line ${first}`);
    await page.waitForTimeout(500);
    await shot("branch-previous");
    await picker.getByRole("button", { name: "Next", exact: true }).click();
    const secondShown = await picker.getByText("2 / 2", { exact: true }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const again = await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    step("Next returns to the second version with its Stopped line", secondShown && again, `picker ${secondShown}, line ${again}`);
    await page.waitForTimeout(500);
    await shot("branch-next");
  }
  await page.waitForTimeout(2_500);
  const left = execFileSync("docker", ["ps", "-a", "--filter", "label=orbit.sandbox=true", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
  step("regenerate after Stop leaves no sandbox container", left === "", left);

  // Regenerate the moment Stop lands, before the saved result can reach the first version.
  const quick = (await (await page.request.post(`${origin}/api/chats`)).json()).id;
  await page.goto(`${origin}/c/${quick}`);
  await startAndStop(page, card, "run-spin");
  const early = (await card.locator("span", { hasText: /^Stopped$/ }).count()) === 0;
  await regenerate.click();
  console.log(`quick regenerate clicked before the first Stopped line: ${early}`);
  await card.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
  const quickStarted = Date.now();
  while (!containerRunning() && Date.now() - quickStarted < 20_000) await page.waitForTimeout(50);
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await card.locator('[data-tool-status="cancelled"]').waitFor({ timeout: 8_000 });
  await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  await picker.getByRole("button", { name: "Previous", exact: true }).click();
  const quickFirstShown = await picker.getByText("1 / 2", { exact: true }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
  const quickFirst = await card.locator("span", { hasText: /^Stopped$/ }).first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
  step("regenerate right after Stop still gives the first version its Stopped line", quickFirstShown && quickFirst, `picker ${quickFirstShown}, line ${quickFirst}`);
  await page.waitForTimeout(500);
  await shot("quick-regenerate-previous");
  await page.waitForTimeout(2_500);
  const quickLeft = execFileSync("docker", ["ps", "-a", "--filter", "label=orbit.sandbox=true", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
  step("regenerate right after Stop leaves no sandbox container", quickLeft === "", quickLeft);
}
