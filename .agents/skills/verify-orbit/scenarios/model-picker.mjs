import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startDropFront } from "../../../../scripts/qa/drop-front.mjs";
import { replyText } from "../../../../scripts/qa/reply-text.mjs";
import { eventually } from "../../../../src/lib/eventually.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const verifyDir = path.join(repoRoot, ".verify");
const requestLog = path.join(verifyDir, "mock-requests.jsonl");
const dataDir = path.join(verifyDir, "sandbox", "data");
const ANTHROPIC_KEY = "anthropic-key-not-real-0001";
const OPENAI_KEY = "test-key-not-real";
const SPARE_KEY = "spare-key-not-real-0003";
const KEYS = [ANTHROPIC_KEY, OPENAI_KEY, SPARE_KEY];
const EFFORT_LABELS = ["None", "Low", "Medium", "High", "Extra high", "Max"];
const TITLE_PROMPT = "Write a title of at most six words.";
const allWords = Array.from({ length: 50 }, (_, index) => `word${index + 1}`);

function logLines() {
  if (!fs.existsSync(requestLog)) return [];
  return fs.readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// A reply request streams. A title request does not, and its prompt asks for a title.
function modelRequests(since) {
  return logLines().slice(since).filter((line) => line.body?.stream === true && !JSON.stringify(line.body).includes(TITLE_PROMPT));
}

const holdsKey = (text) => KEYS.some((key) => text.includes(key));
const words = (text) => text.match(/\bword\d+\b/g) ?? [];

// The part of a control that shows its state needs 3:1 against the surface around it.
async function selectedEffortContrast(grid) {
  await grid.evaluate((root) => Promise.all(root.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  return grid.evaluate((root) => {
    const channels = (color) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color) =>
      channels(color)
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    let surface = root.parentElement;
    while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
    const background = surface ? getComputedStyle(surface).backgroundColor : "";
    const on = root.querySelector("[role=radio][data-state=on]");
    const off = [...root.querySelectorAll("[role=radio][data-state=off]")].find((element) => !element.disabled);
    if (!on || !off) return { selected: Boolean(on), unselected: Boolean(off) };
    return {
      selected: on.textContent.trim(),
      background,
      selectedBorder: Number(ratio(getComputedStyle(on).borderTopColor, background).toFixed(2)),
      unselectedBorder: Number(ratio(getComputedStyle(off).borderTopColor, background).toFixed(2)),
    };
  });
}

const standsOut = (measured) => measured.selectedBorder >= 3 && measured.unselectedBorder < measured.selectedBorder;

export default async function modelPicker({ page, origin, mockUrl, step, shot, useProvider }) {
  const browser = page.context().browser();
  const bodies = [];
  const watch = (target) => target.on("response", (response) => bodies.push(response.text().catch(() => "")));
  watch(page);
  const api = async (method, url, data) => {
    const response = await page.request.fetch(`${origin}${url}`, { method, data, headers: { origin } });
    const text = await response.text();
    bodies.push(Promise.resolve(text));
    return { status: response.status(), text, json: () => JSON.parse(text) };
  };

  const composer = page.getByPlaceholder("Ask anything");
  const chip = page.locator("[data-model-chip]").first();
  const popover = page.locator("[data-model-picker=popover]");
  const option = (picker, model, connectionId) =>
    (connectionId ? picker.locator(`[data-connection-group='${connectionId}']`) : picker).locator(`[data-model-option='${model}']`);
  const effort = (picker, name) => picker.getByRole("radio", { name, exact: true });
  const lastReply = () => page.locator('[data-message-role="assistant"]').last();
  const labelOf = (reply) => reply.locator("[data-reply-label]");
  const visible = (locator, timeout = 15_000) => locator.waitFor({ timeout }).then(() => true, () => false);

  async function openChat(target = page, base = origin) {
    const created = await api("POST", "/api/chats");
    const { id } = created.json();
    await target.goto(`${base}/c/${id}`);
    await target.getByPlaceholder("Ask anything").waitFor();
    return id;
  }

  async function openPicker() {
    await chip.click();
    await popover.waitFor();
    return popover;
  }

  async function closePicker() {
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });
  }

  async function pick(model, effortName, connectionId) {
    const picker = await openPicker();
    await option(picker, model, connectionId).waitFor({ timeout: 20_000 });
    await option(picker, model, connectionId).click();
    if (effortName) await effort(picker, effortName).click();
    await closePicker();
  }

  const replyIds = () => page.locator('[data-message-role="assistant"]').evaluateAll((elements) => elements.map((element) => element.getAttribute("data-message-id")));

  // Waits for a reply that is not one of the replies already on screen, with its label and the Send button back.
  async function nextReply(previousIds) {
    const reply = await eventually(
      async () => {
        const last = lastReply();
        const id = await last.getAttribute("data-message-id").catch(() => null);
        if (!id || previousIds.includes(id)) return null;
        return (await labelOf(last).count()) > 0 && (await page.getByRole("button", { name: "Send", exact: true }).count()) > 0 ? last : null;
      },
      Boolean,
      { timeoutMs: 30_000, what: "a new reply with its label" },
    );
    return { reply, label: (await labelOf(reply).innerText()).trim() };
  }

  async function send(text) {
    const before = await replyIds();
    await composer.fill(text);
    await composer.press("Enter");
    return nextReply(before);
  }

  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  await page.locator("[data-connection-models] [role=switch]").first().waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("[data-connection-kind=anthropic]").click();
  await page.locator("form[data-connection-form] input[type=password]").fill(ANTHROPIC_KEY);
  const [created] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/connections" && response.request().method() === "POST"),
    page.locator("form[data-connection-form] button[type=submit]").click(),
  ]);
  const createdText = await created.text();
  step("anthropic connection saved", created.status() === 201 && JSON.parse(createdText).kind === "anthropic", `POST /api/connections returned ${created.status()}`);
  await page.locator("[data-connection-row]", { hasText: "Anthropic" }).waitFor({ timeout: 20_000 });
  const listed = await api("GET", "/api/connections");
  const settingsRead = await api("GET", "/api/settings");
  step("settings response has no key", ![createdText, listed.text, settingsRead.text].some(holdsKey) && !/"apiKey"/.test(listed.text), "a connections or settings response carried a key");
  const anthropic = listed.json().find((connection) => connection.kind === "anthropic");
  const mock = listed.json().find((connection) => connection.kind === "openai-compatible");

  const haiku = page.locator("[role=switch][data-model-shown='claude-haiku-4-5']");
  await haiku.waitFor({ timeout: 20_000 });
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/${anthropic.id}/hidden-models` && response.ok()),
    haiku.click(),
  ]);
  await page.locator("[role=switch][data-model-shown='claude-haiku-4-5'][aria-checked=false]").waitFor();
  await page.locator("#models").scrollIntoViewIfNeeded();
  await shot("settings-models");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("settings-desktop");

  const anthropicChat = await openChat();
  await chip.click();
  const opened = await visible(popover, 5_000);
  const where = new URL(page.url()).pathname;
  if (!step("chip opens the picker", opened && where === `/c/${anthropicChat}`, `the click went to ${where} and opened no picker`)) return;
  await option(popover, "claude-opus-5-5").waitFor({ timeout: 20_000 });
  const chipBox = await chip.boundingBox();
  const popoverBox = await popover.boundingBox();
  step("popover on desktop", Boolean(chipBox && popoverBox && popoverBox.width <= 384.5 && popoverBox.y + popoverBox.height <= chipBox.y + 1), `popover ${JSON.stringify(popoverBox)} chip ${JSON.stringify(chipBox)}`);
  step("hidden model leaves the picker", (await option(popover, "claude-haiku-4-5").count()) === 0, "claude-haiku-4-5 is still listed");
  await option(popover, "claude-opus-5-5").click();
  step("None is disabled", await effort(popover, "None").isDisabled(), "None is enabled for claude-opus-5-5");
  await effort(popover, "High").click();
  const popoverEffort = await selectedEffortContrast(popover.getByRole("radiogroup", { name: "Effort", exact: true }));
  step("the selected effort stands out in the popover", standsOut(popoverEffort), JSON.stringify(popoverEffort));
  await shot("popover");
  await closePicker();

  let since = logLines().length;
  const first = await send("[qa:claude-think] hello");
  const sent = await eventually(() => modelRequests(since).find((line) => line.scenario === "claude-think"), Boolean, { timeoutMs: 5_000, what: "the claude-think request in the mock log" });
  step("request has effort high", sent.body.output_config?.effort === "high", `output_config ${JSON.stringify(sent.body.output_config)}`);
  step("thinking is adaptive and summarized", sent.body.thinking?.type === "adaptive" && sent.body.thinking?.display === "summarized", `thinking ${JSON.stringify(sent.body.thinking)}`);
  step("cache_control is set", sent.body.cache_control?.type === "ephemeral", `cache_control ${JSON.stringify(sent.body.cache_control)}`);
  step("binding beta header is sent", String(sent.headers?.["anthropic-beta"] ?? "").includes("thinking-binding-controls-2026-08-01"), `anthropic-beta ${sent.headers?.["anthropic-beta"]}`);
  step("no key in the log", !holdsKey(fs.readFileSync(requestLog, "utf8")), "the mock request log holds a key");
  step("reply label reads claude-opus-5-5 · High", first.label === "claude-opus-5-5 · High", `label reads ${first.label}`);
  await page.reload();
  await composer.waitFor();
  const reloaded = await visible(labelOf(lastReply()).getByText("claude-opus-5-5 · High", { exact: true }));
  step("label survives reload", reloaded, "the label is gone after reload");
  step("chat keeps its model after reload", (await chip.innerText()) === "claude-opus-5-5 · High", `chip reads ${await chip.innerText()}`);
  await page.mouse.move(10, 10);
  await shot("label");

  since = logLines().length;
  let before = await replyIds();
  const prompt = page.locator("[data-turn-id]").first();
  await prompt.hover();
  await prompt.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit message" }).fill("[qa:claude-think] hello again");
  await page.locator('form[data-aui-composer-type="edit"]').getByRole("button", { name: "Send", exact: true }).click();
  const edited = await nextReply(before);
  let requests = modelRequests(since);
  step("edit sends claude-opus-5-5 at High", requests.length === 1 && requests[0].body.model === "claude-opus-5-5" && requests[0].body.output_config?.effort === "high", `requests ${JSON.stringify(requests.map((line) => [line.body.model, line.body.output_config]))}`);
  step("edited reply label reads claude-opus-5-5 · High", edited.label === "claude-opus-5-5 · High", `label reads ${edited.label}`);

  since = logLines().length;
  before = await replyIds();
  await lastReply().hover();
  await lastReply().getByRole("button", { name: "Regenerate", exact: true }).click();
  const regenerated = await nextReply(before);
  requests = modelRequests(since);
  step("regenerate sends claude-opus-5-5 at High", requests.length === 1 && requests[0].body.model === "claude-opus-5-5" && requests[0].body.output_config?.effort === "high", `requests ${JSON.stringify(requests.map((line) => [line.body.model, line.body.output_config]))}`);
  step("regenerated reply label reads claude-opus-5-5 · High", regenerated.label === "claude-opus-5-5 · High", `label reads ${regenerated.label}`);

  const reasonerChat = await openChat();
  await pick("mock-reasoner", "Extra high", mock.id);
  const rejected = await send("[qa:effort-reject] hi");
  step("reply marked ignored", rejected.label === "mock-reasoner · Extra high (ignored)", `label reads ${rejected.label}`);
  await page.mouse.move(10, 10);
  await shot("ignored");

  await api("PUT", `/api/connections/${mock.id}/hidden-models`, { modelId: "mock-reasoner", hidden: true });
  await page.reload();
  await composer.waitFor();
  const hiddenChip = await chip.innerText();
  await openPicker();
  await option(popover, "mock-genui", mock.id).waitFor({ timeout: 20_000 });
  const stillListed = await option(popover, "mock-reasoner").count();
  await closePicker();
  since = logLines().length;
  const hiddenReply = await send("[qa:plain] after hiding");
  requests = modelRequests(since);
  step("a hidden model keeps its chip", hiddenChip === "mock-reasoner · Extra high" && stillListed === 0, `chip reads ${hiddenChip}, picker rows for mock-reasoner ${stillListed}`);
  step("a hidden model still sends", requests.length === 1 && requests[0].body.model === "mock-reasoner" && hiddenReply.label.startsWith("mock-reasoner · Extra high"), `requests ${JSON.stringify(requests.map((line) => line.body.model))}, label ${hiddenReply.label}`);
  await api("PUT", `/api/connections/${mock.id}/hidden-models`, { modelId: "mock-reasoner", hidden: false });

  const front = await startDropFront(origin);
  try {
    await page.goto(`${front.origin}/c/${reasonerChat}`);
    await composer.waitFor();
    since = logLines().length;
    const posted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/chat");
    await composer.fill("[qa:slow] answer while I lose the connection");
    await composer.press("Enter");
    const replyId = await (await posted).headerValue("x-resumable-stream-id");
    await page.getByText(/\bword8\b/).waitFor({ timeout: 15_000 });
    const beforeDrop = words(await replyText(lastReply())).length;
    const earlierLabels = (await page.locator("[data-reply-label]").count()) - 1;
    let resume;
    const resumeHeld = new Promise((resolve) => (resume = resolve));
    await page.route("**/api/chats/*/stream**", async (route) => {
      await resumeHeld;
      await route.continue();
    });
    front.drop();
    const reconnecting = await visible(page.getByRole("status").filter({ hasText: "Reconnecting" }), 10_000);
    const labelsWhileReconnecting = await page.locator("[data-reply-label]").evaluateAll((elements) => elements.filter((element) => element.checkVisibility()).length);
    resume();
    step("reply labels stay while a reply reconnects", reconnecting && earlierLabels >= 2 && labelsWhileReconnecting >= earlierLabels, `reconnecting shown ${reconnecting}, ${labelsWhileReconnecting} labels visible of ${earlierLabels} earlier replies`);
    await page.getByText(/\bword50\b/).waitFor({ timeout: 30_000 });
    const resumedLabel = (await visible(labelOf(lastReply()), 15_000)) ? (await labelOf(lastReply()).innerText()).trim() : "";
    const shownWords = words(await replyText(lastReply()));
    const saved = await eventually(
      async () => (await api("GET", `/api/chats/${reasonerChat}`)).json().messages.map(({ message }) => message).filter((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text.includes("word50"))),
      (found) => found.length > 0,
      { timeoutMs: 15_000, what: "the resumed reply in the saved chat" },
    );
    step("reconnect resumes the same reply", saved.length === 1 && saved[0].id === replyId && beforeDrop < 50 && JSON.stringify(shownWords) === JSON.stringify(allWords), `reply id ${replyId}, saved ${JSON.stringify(saved.map((message) => message.id))}, words before drop ${beforeDrop}, shown at end ${shownWords.length}`);
    const slow = modelRequests(since).filter((line) => line.scenario === "slow");
    step("reconnect makes no new provider call", slow.length === 1, `${slow.length} model requests for the reply`);
    step("the resumed reply shows its label", resumedLabel === "mock-reasoner · Extra high", `label reads ${resumedLabel}`);
  } finally {
    await page.unroute("**/api/chats/*/stream**");
    await front.close();
  }

  const cookies = await page.context().storageState();
  for (const [width, height] of [[390, 844], [360, 740]]) {
    const phoneContext = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, storageState: cookies });
    const phone = await phoneContext.newPage();
    watch(phone);
    try {
      await phone.goto(`${origin}/c/${anthropicChat}`);
      await phone.locator("[data-reply-label]").last().waitFor({ timeout: 20_000 });
      if (width === 390) await shot("chat-390", phone);
      await phone.locator("[data-model-chip]").first().tap();
      const sheet = phone.locator("[data-model-picker=sheet]");
      await sheet.waitFor();
      await option(sheet, "claude-opus-5-5").waitFor({ timeout: 20_000 });
      await sheet.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      const box = await sheet.boundingBox();
      if (width === 390) {
        step("bottom sheet on phone", Boolean(box && Math.round(box.width) === width && Math.abs(box.y + box.height - height) <= 1 && box.height <= height * 0.8 + 1), `sheet ${JSON.stringify(box)}`);
        const rowHeights = () => sheet.locator("[data-model-option]").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
        const rows = await rowHeights();
        step("rows are at least 44px", rows.length > 0 && rows.every((rowHeight) => rowHeight >= 44), `row heights ${JSON.stringify(rows)}`);
        const textSize = await phone.evaluate(() => document.documentElement.dataset.textSize ?? null);
        await phone.evaluate(() => (document.documentElement.dataset.textSize = "sm"));
        const smallRows = await rowHeights();
        await phone.evaluate((size) => (size === null ? delete document.documentElement.dataset.textSize : (document.documentElement.dataset.textSize = size)), textSize);
        step("rows are at least 44px at Small text size", smallRows.length > 0 && smallRows.every((rowHeight) => rowHeight >= 44), `row heights ${JSON.stringify(smallRows)}`);
        const sheetEffort = await selectedEffortContrast(sheet.getByRole("radiogroup", { name: "Effort", exact: true }));
        step("the selected effort stands out in the sheet", standsOut(sheetEffort), JSON.stringify(sheetEffort));
      } else {
        const cells = await sheet.getByRole("radio").evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(element);
          const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
          return { name: element.textContent.trim(), left: rect.left, right: rect.right, fits: element.scrollWidth <= element.clientWidth, oneLine: text.getBoundingClientRect().height <= lineHeight + 0.5 };
        }));
        step("effort grid fits at 360", cells.length === EFFORT_LABELS.length && cells.every((cell) => cell.left >= 0 && cell.right <= width && cell.fits && cell.oneLine), `cells ${JSON.stringify(cells)}`);
      }
      await shot(`sheet-${width}`, phone);
      await phone.keyboard.press("Escape");
      if (width === 390) {
        await phone.goto(`${origin}/settings`);
        await phone.getByRole("heading", { name: "Connections" }).waitFor();
        await phone.locator("[data-connection-models] [role=switch]").first().waitFor({ timeout: 20_000 });
        await shot("settings-390", phone);
      }
    } finally {
      await phoneContext.close();
    }
  }

  await api("PUT", `/api/connections/${anthropic.id}/hidden-models`, { modelId: "claude-haiku-4-5", hidden: false });
  await openChat();
  let picker = await openPicker();
  await option(picker, "claude-opus-5-5").waitFor({ timeout: 20_000 });
  await option(picker, "claude-opus-5-5").click();
  await effort(picker, "High").click();
  await option(picker, "claude-haiku-4-5").click();
  const haikuEnabled = await picker.getByRole("radio").evaluateAll((elements) => elements.filter((element) => !element.disabled).map((element) => element.textContent.trim()));
  const haikuPicked = (await picker.locator("[role=radio][data-state=on]").allInnerTexts()).map((text) => text.trim());
  step("claude-haiku-4-5 takes only None", JSON.stringify(haikuEnabled) === JSON.stringify(["None"]), `enabled ${JSON.stringify(haikuEnabled)}`);
  step("High moves to the nearest level claude-haiku-4-5 takes", JSON.stringify(haikuPicked) === JSON.stringify(["None"]), `picked ${JSON.stringify(haikuPicked)}`);
  await option(picker, "mock-genui", mock.id).click();
  const genuiEnabled = await picker.getByRole("radio").evaluateAll((elements) => elements.filter((element) => !element.disabled).length);
  await closePicker();
  const genuiChip = await chip.innerText();
  step("mock-genui takes no effort level", genuiEnabled === 0, `${genuiEnabled} levels enabled`);
  step("switching to mock-genui shows no effort", genuiChip === "mock-genui", `chip reads ${genuiChip}`);
  const genuiReply = await send("[qa:plain] no effort");
  step("a mock-genui reply label names the model only", genuiReply.label === "mock-genui", `label reads ${genuiReply.label}`);

  const staleChat = (await api("POST", "/api/chats")).json().id;
  since = logLines().length;
  const stale = await api("POST", "/api/chat", {
    id: staleChat,
    trigger: "submit-message",
    messages: [{ id: randomUUID(), role: "user", parts: [{ type: "text", text: "[qa:plain] stale client" }] }],
    modelChoice: { connectionId: anthropic.id, model: "claude-haiku-4-5", effort: "high" },
  });
  const staleSent = modelRequests(since).find((line) => line.body.model === "claude-haiku-4-5");
  const staleSaved = await eventually(
    async () => (await api("GET", `/api/chats/${staleChat}`)).json().messages.map(({ message }) => message).find((message) => message.role === "assistant")?.metadata?.reply,
    Boolean,
    { timeoutMs: 10_000, what: "the stale-client reply record" },
  );
  step("a stale effort is saved as adjusted", stale.status === 200 && staleSaved.model === "claude-haiku-4-5" && staleSaved.effort === "high" && staleSaved.effortOutcome === "adjusted", `status ${stale.status}, record ${JSON.stringify(staleSaved)}`);
  step("a stale effort sends the nearest level", Boolean(staleSent) && staleSent.body.output_config?.effort === undefined && staleSent.body.thinking?.type === "disabled", `request ${JSON.stringify({ output_config: staleSent?.body.output_config, thinking: staleSent?.body.thinking })}`);

  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  const defaultsForm = page.locator("form[aria-labelledby=default-model-heading]");
  await defaultsForm.locator("#default-connection").click();
  await page.getByRole("option", { name: "Anthropic", exact: true }).click();
  await defaultsForm.locator("[role=combobox][aria-labelledby=default-model-label]").click();
  await page.getByRole("option", { name: "claude-opus-5-5", exact: true }).click();
  const settingsEffort = await selectedEffortContrast(defaultsForm.getByRole("radiogroup", { name: "Effort", exact: true }));
  step("the selected effort stands out in Settings", standsOut(settingsEffort), JSON.stringify(settingsEffort));
  await shot("settings-default-model");
  await page.getByRole("button", { name: "Delete Anthropic", exact: true }).click();
  await page.getByRole("heading", { name: "Delete Anthropic?" }).waitFor();
  const [deleted] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/${anthropic.id}` && response.request().method() === "DELETE"),
    page.getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await page.locator(`[data-connection-row='${anthropic.id}']`).waitFor({ state: "detached" });
  step("Delete asks once and removes the connection", deleted.ok(), `DELETE returned ${deleted.status()}`);
  const saveAfterDelete = defaultsForm.getByRole("button", { name: "Save", exact: true });
  step("deleting the chosen connection clears the default model draft", await saveAfterDelete.isDisabled(), "Save is enabled with the deleted connection's model");
  await page.goto(`${origin}/c/${anthropicChat}`);
  await labelOf(lastReply()).waitFor({ timeout: 20_000 });
  const oldLabels = (await page.locator("[data-reply-label]").allInnerTexts()).map((text) => text.trim());
  picker = await openPicker();
  await option(picker, "mock-genui", mock.id).waitFor({ timeout: 20_000 });
  const claudeRows = await picker.locator("[data-model-option^='claude-']").count();
  await closePicker();
  step("the picker no longer lists Anthropic models", claudeRows === 0, `${claudeRows} claude rows`);
  since = logLines().length;
  const afterDelete = await send("[qa:plain] after the delete");
  requests = modelRequests(since);
  step("the chat sends with the defaults after the delete", requests.length === 1 && requests[0].body.model === "mock-genui" && afterDelete.label === "mock-genui", `requests ${JSON.stringify(requests.map((line) => line.body.model))}, label ${afterDelete.label}`);
  await page.reload();
  await labelOf(lastReply()).waitFor({ timeout: 20_000 });
  const keptLabels = (await page.locator("[data-reply-label]").allInnerTexts()).map((text) => text.trim());
  step("old replies keep their labels after the delete", oldLabels.length > 0 && oldLabels.every((text) => text === "claude-opus-5-5 · High") && keptLabels[0] === "claude-opus-5-5 · High", `before send ${JSON.stringify(oldLabels)}, after reload ${JSON.stringify(keptLabels)}`);

  const spare = await api("POST", "/api/connections", { kind: "openai-compatible", label: "Spare", baseUrl: mockUrl, apiKey: SPARE_KEY });
  const spareId = spare.json().id;
  const brokenChat = await openChat();
  await pick("mock-reasoner", "Medium", spareId);
  await send("[qa:plain] before the key breaks");
  const db = new Database(path.join(dataDir, "orbit.db"));
  try {
    db.pragma("busy_timeout = 5000");
    const { stored } = db.prepare("select api_key_ciphertext as stored from provider_connections where id = ?").get(spareId);
    const parts = stored.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    db.prepare("update provider_connections set api_key_ciphertext = ? where id = ?").run(parts.join("."), spareId);
  } finally {
    db.close();
  }
  await page.goto(`${origin}/c/${brokenChat}`);
  await composer.waitFor();
  const brokenChip = await visible(chip, 10_000);
  step("a chat whose key cannot be read shows the chip", brokenChip, "no chip on the chat");
  await page.goto(`${origin}/settings`);
  const brokenRow = page.locator(`[data-connection-row='${spareId}']`);
  await brokenRow.waitFor();
  const marked = await visible(brokenRow.getByText("Key unreadable", { exact: true }), 5_000);
  const otherMarked = await page.locator(`[data-connection-row='${mock.id}']`).getByText("Key unreadable", { exact: true }).count();
  step("Settings marks the connection whose key cannot be read", marked && otherMarked === 0, `marked ${marked}, other rows marked ${otherMarked}`);
  await shot("settings-key-unreadable");
  await page.goto(`${origin}/c/${brokenChat}`);
  await composer.waitFor();
  if (brokenChip) {
    await composer.fill("[qa:plain] with a broken key");
    await composer.press("Enter");
    const keyError = await visible(page.getByText(/Re-enter the API key/), 15_000);
    await shot("key-unreadable");
    step("sending with an unreadable key says Re-enter the API key", keyError, "no key error on screen");
    const chipOpens = await chip.click().then(() => visible(popover, 5_000));
    step("the chip opens the picker when the key cannot be read", chipOpens, "no picker");
    if (chipOpens) {
      await closePicker();
      await pick("mock-genui", null, mock.id);
      const failedIds = await replyIds();
      await lastReply().getByRole("button", { name: "Retry", exact: true }).click();
      const recovered = await nextReply(failedIds);
      step("Retry with another model answers after the key error", recovered.label === "mock-genui", `label reads ${recovered.label}`);
    }
  }
  await api("DELETE", `/api/connections/${spareId}`);

  const gone = (await api("POST", "/api/connections", { kind: "openai-compatible", label: "Gone", baseUrl: mockUrl, apiKey: SPARE_KEY })).json();
  const mountedChat = await openChat();
  await pick("mock-reasoner", "Medium", gone.id);
  before = await replyIds();
  await composer.fill("[qa:slow] answer while the connection goes");
  await composer.press("Enter");
  await page.getByText(/\bword8\b/).waitFor({ timeout: 15_000 });
  await api("DELETE", `/api/connections/${gone.id}`);
  await nextReply(before);
  const followed = await eventually(() => chip.innerText(), (text) => text === "mock-genui", { timeoutMs: 10_000, what: "the chip to show the defaults" }).then(() => true, () => false);
  step("a mounted chat drops a choice whose connection is gone", followed, `chip reads ${await chip.innerText()} in /c/${mountedChat}`);
  since = logLines().length;
  const afterGone = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/chat");
  before = await replyIds();
  await composer.fill("[qa:plain] after the connection went");
  await composer.press("Enter");
  const afterGoneStatus = (await afterGone).status();
  const afterGoneReply = afterGoneStatus === 200 ? await nextReply(before) : null;
  requests = modelRequests(since);
  step("the next send uses the defaults", afterGoneStatus === 200 && requests.length === 1 && requests[0].body.model === "mock-genui" && afterGoneReply?.label === "mock-genui", `POST /api/chat ${afterGoneStatus}, requests ${JSON.stringify(requests.map((line) => line.body.model))}`);

  await api("DELETE", `/api/connections/${mock.id}`);
  const none = (await api("GET", "/api/connections")).json();
  await page.goto(`${origin}/c/${reasonerChat}`);
  await labelOf(lastReply()).waitFor({ timeout: 20_000 });
  picker = await openPicker();
  const addConnection = picker.getByRole("link", { name: "Add connection", exact: true });
  const offered = none.length === 0 && (await visible(addConnection, 5_000));
  await picker.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  await shot("no-connection");
  if (offered) {
    await addConnection.click();
    await page.waitForURL((url) => url.pathname === "/settings");
  }
  const setup = offered && (await visible(page.getByRole("button", { name: "Add", exact: true }), 10_000));
  step("a chat with history and no connection leads to setup", setup, `connections ${none.length}, Add connection offered ${offered}`);
  await useProvider();

  const texts = await Promise.all(bodies);
  const leakedBodies = texts.filter(holdsKey).length;
  const files = ["server.log", "mock.log", "mock-requests.jsonl"].map((name) => path.join(verifyDir, name)).concat(["orbit.db", "orbit.db-wal"].map((name) => path.join(dataDir, name)));
  const leakedFiles = files.filter((file) => fs.existsSync(file) && KEYS.some((key) => fs.readFileSync(file).includes(Buffer.from(key))));
  step("no response body holds a key", texts.length > 0 && leakedBodies === 0, `${leakedBodies} of ${texts.length} bodies hold a key`);
  step("no log or database file holds a key", leakedFiles.length === 0, `key bytes in ${leakedFiles.map((file) => path.relative(repoRoot, file)).join(", ")}`);
}
