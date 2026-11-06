import { execFileSync } from "node:child_process";

const cases = [
  { scenario: "run-timeout", printed: "before-timeout\n" },
  { scenario: "run-spin", printed: "" },
];

const containerRunning = () => execFileSync("docker", ["ps", "--filter", "label=orbit.sandbox=true", "--filter", "status=running", "--format", "{{.ID}}"], { encoding: "utf8" }).trim() !== "";

export default async function sandboxStopOutput({ page, origin, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: "http://127.0.0.1:3299/v1", apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const card = page.locator('[data-tool-name="run_code"]');
  for (const { scenario, printed } of cases) {
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder("Ask anything");
    await composer.fill(`[qa:${scenario}]`);
    await composer.press("Enter");
    await card.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
    const started = Date.now();
    while (!containerRunning() && Date.now() - started < 20_000) await page.waitForTimeout(50);
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await card.locator('[data-tool-status="cancelled"]').waitFor({ timeout: 8_000 });
    step(`${scenario} Stop turns the running card to Cancelled`, true);

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
    await card.scrollIntoViewIfNeeded();
    await shot(`${scenario}-stopped`);

    await page.waitForTimeout(2_500);
    const left = execFileSync("docker", ["ps", "-a", "--filter", "label=orbit.sandbox=true", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
    step(`${scenario} leaves no sandbox container`, left === "", left);
  }
}
