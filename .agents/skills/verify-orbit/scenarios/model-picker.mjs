import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventually } from "../../../../src/lib/eventually.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const requestLog = path.join(repoRoot, ".verify", "mock-requests.jsonl");
const ANTHROPIC_KEY = "anthropic-key-not-real-0001";
const OPENAI_KEY = "test-key-not-real";
const EFFORT_LABELS = ["None", "Low", "Medium", "High", "Extra high", "Max"];
const MODEL_ROW = /^\s*(claude-|mock-)/;

function logLines() {
  if (!fs.existsSync(requestLog)) return [];
  return fs.readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function chatRequest(lines, scenario, since) {
  return lines.slice(since).findLast((line) => line.scenario === scenario && line.body?.stream === true && !JSON.stringify(line.body).includes("Write a title of at most six words."));
}

export default async function modelPicker({ page, origin, step, shot }) {
  const composer = page.getByPlaceholder("Ask anything");
  const form = page.locator("form").filter({ has: composer });
  const chip = form.locator("a, button").filter({ hasText: MODEL_ROW }).first();
  const picker = page.getByRole("dialog");
  const pickerOpens = () => picker.waitFor({ timeout: 5_000 }).then(() => true, () => false);

  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  await composer.waitFor();

  await chip.click();
  const opened = await pickerOpens();
  const where = new URL(page.url()).pathname;
  await shot("chip-click");
  if (!step("chip opens the picker", opened && where === `/c/${id}`, `the click went to ${where} and opened no picker`)) return;

  const chipBox = await chip.boundingBox();
  const popoverBox = await picker.boundingBox();
  step(
    "popover on desktop",
    Boolean(chipBox && popoverBox && popoverBox.width <= 400 && popoverBox.y + popoverBox.height <= chipBox.y + 1),
    `popover ${JSON.stringify(popoverBox)} chip ${JSON.stringify(chipBox)}`,
  );
  await shot("popover");
  await page.keyboard.press("Escape");

  await page.goto(`${origin}/settings#connections`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Kind").selectOption({ label: "Anthropic" });
  await page.getByLabel("Label").fill("Claude");
  await page.getByLabel("API key").fill(ANTHROPIC_KEY);
  const [created] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/connections" && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const createdText = await created.text();
  step("anthropic connection saved", created.ok() && JSON.parse(createdText).kind === "anthropic", `POST /api/connections returned ${created.status()}`);
  const listed = await (await page.request.get(`${origin}/api/connections`)).text();
  step("settings response has no key", ![createdText, listed].some((text) => text.includes(ANTHROPIC_KEY) || text.includes(OPENAI_KEY)), "a connections response carried a key");
  const anthropic = JSON.parse(listed).find((connection) => connection.kind === "anthropic");

  await page.goto(`${origin}/settings#models`);
  const haikuRow = page.locator("li, [role=row]").filter({ hasText: "claude-haiku-4-5" }).first();
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/${anthropic?.id}/hidden-models` && response.ok()),
    haikuRow.getByRole("switch").click(),
  ]);
  await shot("settings-models");

  await page.goto(`${origin}/c/${id}`);
  await composer.waitFor();
  await chip.click();
  await pickerOpens();
  await picker.getByText("claude-opus-5-5", { exact: true }).waitFor();
  step("hidden model leaves the picker", (await picker.getByText("claude-haiku-4-5", { exact: true }).count()) === 0, "claude-haiku-4-5 is still listed");

  await picker.getByText("claude-opus-5-5", { exact: true }).click();
  if (!(await picker.isVisible())) {
    await chip.click();
    await pickerOpens();
  }
  step("None is disabled", await picker.getByRole("button", { name: "None", exact: true }).isDisabled(), "None is enabled for claude-opus-5-5");
  await picker.getByRole("button", { name: "High", exact: true }).click();
  if (await picker.isVisible()) await page.keyboard.press("Escape");

  const before = logLines().length;
  await composer.fill("[qa:claude-think] hello");
  await composer.press("Enter");
  const reply = page.locator('[data-message-role="assistant"]').last();
  await reply.getByText("Hello from the mock Claude.").waitFor({ timeout: 20_000 });

  const sent = await eventually(() => chatRequest(logLines(), "claude-think", before), Boolean, { timeoutMs: 5_000, what: "the claude-think request in the mock log" });
  step("request has effort high", sent.body.output_config?.effort === "high", `output_config ${JSON.stringify(sent.body.output_config)}`);
  step("thinking is adaptive and summarized", sent.body.thinking?.type === "adaptive" && sent.body.thinking?.display === "summarized", `thinking ${JSON.stringify(sent.body.thinking)}`);
  step("cache_control is set", sent.body.cache_control?.type === "ephemeral", `cache_control ${JSON.stringify(sent.body.cache_control)}`);
  step("binding beta header is sent", String(sent.headers?.["anthropic-beta"] ?? "").includes("thinking-binding-controls-2026-08-01"), `anthropic-beta ${sent.headers?.["anthropic-beta"]}`);
  const rawLog = fs.readFileSync(requestLog, "utf8");
  step("no key in the log", !rawLog.includes(ANTHROPIC_KEY) && !rawLog.includes(OPENAI_KEY), "the mock request log holds a key");

  const label = reply.getByText("claude-opus-5-5 · High", { exact: true });
  step("reply label reads claude-opus-5-5 · High", await label.waitFor({ timeout: 10_000 }).then(() => true, () => false), "no label on the reply");
  await page.reload();
  await composer.waitFor();
  const reloaded = page.locator('[data-message-role="assistant"]').last().getByText("claude-opus-5-5 · High", { exact: true });
  step("label survives reload", await reloaded.waitFor({ timeout: 10_000 }).then(() => true, () => false), "the label is gone after reload");
  step("chat keeps its model after reload", (await chip.innerText()).includes("claude-opus-5-5"), `chip reads ${await chip.innerText()}`);
  await shot("label");

  await chip.click();
  await pickerOpens();
  await picker.getByText("mock-reasoner", { exact: true }).click();
  if (!(await picker.isVisible())) {
    await chip.click();
    await pickerOpens();
  }
  await picker.getByRole("button", { name: "Extra high", exact: true }).click();
  if (await picker.isVisible()) await page.keyboard.press("Escape");
  await composer.fill("[qa:effort-reject] hi");
  await composer.press("Enter");
  const rejected = page.locator('[data-message-role="assistant"]').last();
  await rejected.getByText("pong", { exact: true }).waitFor({ timeout: 20_000 });
  const ignored = rejected.getByText("mock-reasoner · Extra high (ignored)", { exact: true });
  step("reply marked ignored", await ignored.waitFor({ timeout: 10_000 }).then(() => true, () => false), "no ignored mark on the reply");
  await shot("ignored");

  for (const [width, height] of [[390, 844], [360, 740]]) {
    await page.setViewportSize({ width, height });
    await chip.click();
    await pickerOpens();
    const sheet = await picker.boundingBox();
    if (width === 390) {
      step("bottom sheet on phone", Boolean(sheet && Math.round(sheet.width) === width && Math.round(sheet.y + sheet.height) === height), `sheet ${JSON.stringify(sheet)}`);
      const rows = await picker.locator("button, [role=option], [role=menuitemradio]").filter({ hasText: MODEL_ROW }).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      step("rows are at least 44px", rows.length > 0 && rows.every((rowHeight) => rowHeight >= 44), `row heights ${JSON.stringify(rows)}`);
    } else {
      const cells = await Promise.all(EFFORT_LABELS.map((name) => picker.getByRole("button", { name, exact: true }).evaluate((element) => {
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const oneLine = range.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(element).fontSize);
        return { name: element.textContent.trim(), left: box.left, right: box.right, oneLine };
      })));
      step("effort grid fits at 360", cells.every((cell) => cell.left >= 0 && cell.right <= width && cell.oneLine), `cells ${JSON.stringify(cells)}`);
    }
    await shot(`sheet-${width}`);
    await page.keyboard.press("Escape");
  }
}
