import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eventually } from "../../../../src/lib/eventually.mjs";

// Slice 16 reading checks: the 12-line fold, touch action placement, top-anchored streaming, the Jump to latest
// strip, the artifact card and themed preview, code Wrap, palette rows and snippets, the phone Prompts sheet,
// and the Memory page dream status. Each viewport runs every check except the Memory setup, which runs once.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.join(repoRoot, ".verify", "sandbox", "data");
const VIEWPORTS = [
  { label: "1440", viewport: { width: 1440, height: 900 }, touch: false },
  { label: "390", viewport: { width: 390, height: 844 }, touch: true },
  { label: "360", viewport: { width: 360, height: 740 }, touch: true },
];
const FOLD_LINES = Array.from({ length: 40 }, (_, index) => `Fold line ${index + 1} of the pasted deploy log`);
// The last paragraph of the mock's [qa:slow-long] reply, as innerText reads it.
const LAST_SLOW_LONG_PARAGRAPH =
  "Paragraph 80 of 80. The reader should still see the start of this answer while it streams, because the prompt stays pinned near the top and new text grows below it without moving the page.";
const LONG_TITLE = "Deploy notes for the small server with a title long enough to need an ellipsis in the palette row";
// A browser time zone that differs from the server's, so a server-formatted time cannot pass.
const BROWSER_TIME_ZONE = "Asia/Kolkata";

const lastReply = (page) => page.locator('[data-message-role="assistant"]').last();
const visible = (locator, timeout = 10_000) => locator.waitFor({ timeout }).then(() => true, () => false);
// Waits for a control and names it when it never shows, so the first missing control is the failure line.
async function need(locator, what, timeout = 10_000) {
  if (!(await visible(locator, timeout))) throw new Error(`no ${what} after ${timeout}ms`);
  return locator;
}

async function sendPrompt(page, text) {
  const composer = page.getByPlaceholder("Ask anything");
  await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the composer to be ready" });
  const before = await page.locator("[data-turn-id]").count();
  await composer.fill(text);
  await composer.press("Enter");
  await eventually(() => page.locator("[data-turn-id]").count(), (count) => count > before, { timeoutMs: 10_000, what: "the prompt to show" });
}

async function replyDone(page, text, timeoutMs = 30_000) {
  await lastReply(page).getByText(text).first().waitFor({ timeout: timeoutMs });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: timeoutMs });
}

// The scrolling thread is the nearest scrollable ancestor of the first prompt. An init script defines the
// finder, so page code reads it without eval under the app's CSP.
function defineViewportOf() {
  window.__viewportOf = (start) => {
    let node = start;
    while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
    return node;
  };
}

async function threadMetrics(page) {
  return page.evaluate(() => {
    const viewport = window.__viewportOf(document.querySelector("[data-turn-id]"));
    if (!viewport) return null;
    return { scrollTop: viewport.scrollTop, clientHeight: viewport.clientHeight, scrollHeight: viewport.scrollHeight };
  });
}

// The user text is one text node inside the fold box, so no element wraps a single line. A Range over the line's
// words gives its box. The init script defines it, so page code reads it without eval under the app's CSP.
function defineLineBox() {
  window.__lineBox = (container, text) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const rects = [...range.getClientRects()];
      return { top: rects[0].top, bottom: rects.at(-1).bottom };
    }
    return null;
  };
}

// Copy and Edit under the bubble, the fold, and Copy while folded.
async function checkFold(page, { label, touch, step, shot }) {
  await sendPrompt(page, `[qa:plain] ${FOLD_LINES.join("\n")}`);
  await replyDone(page, "pong");
  const turn = page.locator("[data-turn-id]").first();
  const more = await need(turn.getByRole("button", { name: "Show more", exact: true }), "Show more button on the 40-line message");
  // The fade is the box's aria-hidden sibling. It must cover the last shown line and end at the fold.
  const folded = await turn.evaluate((root) => {
    const box = root.querySelector('[data-folded="true"]');
    if (!box) return null;
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
    const rect = box.getBoundingClientRect();
    const last = window.__lineBox(box, "Fold line 40 of");
    const fade = [...box.parentElement.children].find((node) => node !== box && node.getAttribute("aria-hidden") === "true")?.getBoundingClientRect();
    return {
      lines: rect.height / lineHeight,
      lineHeight,
      height: rect.height,
      lastHidden: Boolean(last) && last.top >= rect.bottom - 1,
      fade: fade ? { lines: fade.height / lineHeight, gapToFold: rect.bottom - fade.bottom } : null,
    };
  });
  step(
    `${label}: a 40-line message folds to 12 lines with a fade over the last line`,
    Boolean(folded) &&
      Math.round(folded.lines) === 12 &&
      folded.lastHidden &&
      Boolean(folded.fade) &&
      Math.round(folded.fade.lines) === 1 &&
      Math.abs(folded.fade.gapToFold) <= 1 &&
      (await more.getAttribute("aria-expanded")) === "false",
    JSON.stringify(folded),
  );
  if (label === "390") await shot("folded-390");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  if (!touch) await turn.hover();
  await turn.getByRole("button", { name: "Copy", exact: true }).click();
  const copied = await eventually(() => page.evaluate(() => navigator.clipboard.readText()), (text) => text.includes("Fold line 40"), { timeoutMs: 5_000, what: "the clipboard to hold the message" }).catch(() => "");
  // The first line carries the [qa:plain] tag the prompt was sent with.
  const copiedLines = copied.split("\n").map((line) => line.replace(/^\[qa:plain\] /, ""));
  const whole = copiedLines.length === FOLD_LINES.length && FOLD_LINES.every((line, index) => copiedLines[index] === line);
  step(
    `${label}: Copy while folded copies all 40 lines`,
    whole,
    `copied ${copiedLines.filter((line) => FOLD_LINES.includes(line)).length} of ${FOLD_LINES.length} lines, first ${JSON.stringify(copiedLines[0])}, last ${JSON.stringify(copiedLines.at(-1))}`,
  );

  await more.click();
  const less = turn.getByRole("button", { name: "Show less", exact: true });
  const expanded = await visible(less, 5_000);
  // Expanded, the text box Show less controls clips nothing and ends with the 40th line.
  const open = await turn.evaluate((root) => {
    const box = document.getElementById(root.querySelector("button[aria-controls]")?.getAttribute("aria-controls") ?? "");
    const last = box ? window.__lineBox(box, "Fold line 40 of") : null;
    const rect = box?.getBoundingClientRect();
    return {
      folded: root.querySelector('[data-folded="true"]') !== null,
      lastShown: Boolean(box && last) && box.scrollHeight <= box.clientHeight + 1 && last.bottom <= rect.bottom + 1,
    };
  });
  step(
    `${label}: Show more reveals all 40 lines and turns into Show less`,
    expanded && (await less.getAttribute("aria-expanded")) === "true" && !open.folded && open.lastShown,
    `Show less ${expanded}, ${JSON.stringify(open)}`,
  );
  await less.click();
  await more.waitFor({ timeout: 5_000 });

  // The bubble is the first ancestor of the message text that paints a border.
  const placement = await turn.evaluate((root) => {
    const text = [...root.querySelectorAll("*")].find((node) => node.childElementCount === 0 && node.textContent.includes("Fold line 1 "));
    let bubble = text;
    while (bubble && bubble !== root && parseFloat(getComputedStyle(bubble).borderTopWidth) === 0) bubble = bubble.parentElement;
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const button = (name) => [...root.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === name || node.textContent.trim() === name);
    const copy = button("Copy");
    const edit = button("Edit");
    return { bubble: bubble ? box(bubble) : null, copy: copy ? box(copy) : null, edit: edit ? box(edit) : null };
  });
  const { bubble, copy, edit } = placement;
  if (touch) {
    step(
      `${label}: touch Copy and Edit sit below the bubble at 44px or taller`,
      Boolean(bubble && copy && edit) && copy.top >= bubble.bottom - 0.5 && edit.top >= bubble.bottom - 0.5 && copy.height >= 44 && edit.height >= 44,
      JSON.stringify(placement),
    );
    if (label === "390") await shot("touch-actions-390");
  } else {
    step(
      `${label}: desktop Copy and Edit sit beside the bubble`,
      Boolean(bubble && copy && edit) && copy.right <= bubble.left + 0.5 && edit.right <= bubble.left + 0.5 && copy.top < bubble.bottom,
      JSON.stringify(placement),
    );
  }

  if (touch) {
    const row = await lastReply(page).evaluate((reply) => {
      const label = reply.querySelector("[data-reply-label]");
      if (!label) return null;
      const row = label.parentElement;
      const rect = (node) => node.getBoundingClientRect();
      const rowBox = rect(row);
      const labelBox = rect(label);
      const buttons = [...row.querySelectorAll("button")].filter((node) => rect(node).width > 0).map((node) => {
        const box = rect(node);
        const overlapsLabel = box.left < labelBox.right && box.right > labelBox.left && box.top < labelBox.bottom && box.bottom > labelBox.top;
        return { name: node.getAttribute("aria-label") ?? node.textContent.trim(), height: box.height, inside: box.top >= rowBox.top - 0.5 && box.bottom <= rowBox.bottom + 0.5, overlapsLabel };
      });
      return { rowHeight: rowBox.height, buttons };
    });
    step(
      `${label}: assistant actions beside the reply label are 44px and neither overlap nor clip`,
      Boolean(row) && row.rowHeight >= 44 && row.buttons.length > 0 && row.buttons.every((button) => button.height >= 44 && button.inside && !button.overlapsLabel),
      JSON.stringify(row),
    );
  }
}

// The prompt pins near the top and the page stops following the reply. Jump to latest reaches the end.
async function checkStreaming(page, { label, step, shot }) {
  await page.evaluate(() => {
    const find = window.__viewportOf;
    const samples = [];
    const started = performance.now();
    const read = () => {
      const prompts = document.querySelectorAll("[data-turn-id]");
      const prompt = prompts[prompts.length - 1];
      const viewport = find(prompts[0]);
      if (viewport && prompt) {
        samples.push({
          t: Math.round(performance.now() - started),
          scrollTop: Math.round(viewport.scrollTop),
          promptTop: Math.round(prompt.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
          prompt: prompt.textContent.includes("[qa:slow-long]"),
        });
      }
      if (!window.__streamDone) requestAnimationFrame(read);
    };
    window.__streamDone = false;
    window.__streamSamples = samples;
    requestAnimationFrame(read);
  });
  await sendPrompt(page, "[qa:slow-long] write a long answer");
  await lastReply(page).getByText("Paragraph 30 of 80.").waitFor({ state: "attached", timeout: 20_000 });
  await shot(label === "1440" ? "streaming-top" : `streaming-top-${label}`);
  await replyDone(page, "Paragraph 80 of 80.", 30_000);
  const samples = await page.evaluate(() => {
    window.__streamDone = true;
    return window.__streamSamples.filter((sample) => sample.prompt);
  });
  const pinned = samples.findIndex((sample) => sample.promptTop >= -4 && sample.promptTop <= 96);
  const settleAt = pinned === -1 ? -1 : samples.findIndex((sample) => sample.t >= samples[pinned].t + 500);
  const after = settleAt === -1 ? [] : samples.slice(settleAt);
  const rises = after.filter((sample, index) => index > 0 && sample.scrollTop > after[index - 1].scrollTop + 2).length;
  const last = samples.at(-1);
  const summary = `samples ${samples.length}, first ${JSON.stringify(samples[0])}, pinned ${JSON.stringify(samples[pinned] ?? null)}, last ${JSON.stringify(last)}, rises after pin ${rises}`;
  step(`${label}: during [qa:slow-long] the prompt anchors at the top`, pinned !== -1 && last.promptTop >= -4 && last.promptTop <= 96, summary);
  step(`${label}: scrollTop stops increasing once the prompt is pinned`, after.length > 0 && rises === 0, summary);

  // The markdown reveal still types out the last paragraph after the stream ends, and that adds a line under a jump
  // made earlier. Jump once the whole reply shows.
  await eventually(() => lastReply(page).innerText(), (text) => text.includes(LAST_SLOW_LONG_PARAGRAPH), { timeoutMs: 10_000, what: "the last paragraph to finish showing" });
  const jump = await need(page.locator("[data-scroll-to-bottom]"), "[data-scroll-to-bottom] Jump to latest button");
  await eventually(() => jump.isEnabled(), Boolean, { timeoutMs: 5_000, what: "Jump to latest to be enabled" });
  step(`${label}: Jump to latest shows its label`, (await jump.innerText()).includes("Jump to latest"), `text ${JSON.stringify(await jump.innerText())}`);
  await jump.click();
  const atEnd = (metrics) => Boolean(metrics) && metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2;
  const end = await eventually(() => threadMetrics(page), atEnd, { timeoutMs: 5_000, what: "the thread to reach the end" }).catch(() => threadMetrics(page));
  const lastParagraph = await lastReply(page).getByText("Paragraph 80 of 80.").boundingBox();
  step(`${label}: Jump to latest reaches the end`, atEnd(end) && Boolean(lastParagraph) && lastParagraph.y < page.viewportSize().height, `metrics ${JSON.stringify(end)}, last paragraph ${JSON.stringify(lastParagraph)}`);
}

// The button sits inside an opaque strip, and nothing behind it is message text.
async function checkJumpStrip(page, { label, step, shot }) {
  await page.evaluate(() => {
    const viewport = window.__viewportOf(document.querySelector("[data-turn-id]"));
    viewport.scrollTop = Math.round(viewport.scrollHeight / 2);
  });
  const jump = await need(page.locator("[data-scroll-to-bottom]"), "[data-scroll-to-bottom] Jump to latest button");
  await eventually(() => jump.isEnabled(), Boolean, { timeoutMs: 5_000, what: "Jump to latest to be enabled" });
  if (label === "390") await shot("jump-strip-390");
  const cover = await jump.evaluate((button) => {
    const strip = button.closest("[data-jump-strip]");
    if (!strip) return { strip: false };
    const box = button.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const inside = box.left >= stripBox.left - 0.5 && box.right <= stripBox.right + 0.5 && box.top >= stripBox.top - 0.5 && box.bottom <= stripBox.bottom + 0.5;
    const background = getComputedStyle(strip).backgroundColor;
    const alpha = background.startsWith("rgba") ? Number(background.split(",")[3].replace(")", "")) : 1;
    button.style.visibility = "hidden";
    const corners = [
      [box.left + 1, box.top + 1],
      [box.right - 1, box.top + 1],
      [box.left + 1, box.bottom - 1],
      [box.right - 1, box.bottom - 1],
    ].map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return { inStrip: Boolean(hit?.closest("[data-jump-strip]")), inMessage: Boolean(hit?.closest("[data-message-role], [data-turn-id]")), tag: hit?.tagName.toLowerCase() };
    });
    button.style.visibility = "";
    return { strip: true, inside, background, alpha, stripHeight: stripBox.height, corners };
  });
  step(
    `${label}: Jump to latest sits inside an opaque strip that covers no text`,
    cover.strip && cover.inside && cover.alpha === 1 && cover.stripHeight >= 44 && cover.corners.every((corner) => corner.inStrip && !corner.inMessage),
    JSON.stringify(cover),
  );
}

async function frameStyle(page) {
  const panel = page.getByRole("complementary", { name: "Artifact" }).or(page.getByRole("dialog", { name: "Artifact" }));
  await panel.waitFor({ timeout: 10_000 });
  const preview = panel.getByRole("tab", { name: "Preview" });
  if ((await preview.getAttribute("aria-selected")) !== "true") await preview.click();
  const frame = await (await panel.locator("iframe").elementHandle()).contentFrame();
  await frame.locator("button").waitFor({ timeout: 10_000 });
  const style = await frame.evaluate(() => {
    const body = getComputedStyle(document.body);
    return { background: body.backgroundColor, color: body.color, font: body.fontFamily, radius: getComputedStyle(document.querySelector("button")).borderTopLeftRadius };
  });
  const app = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;background-color:var(--background);border-radius:var(--radius)";
    document.body.append(probe);
    const resolved = { background: getComputedStyle(probe).backgroundColor, radius: getComputedStyle(probe).borderTopLeftRadius };
    probe.remove();
    return resolved;
  });
  return { panel, style, app };
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function luminance(color) {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function checkArtifact(page, { label, origin, chatId, step, shot }) {
  await sendPrompt(page, "[qa:artifact-form] build a signup form");
  const card = await need(page.locator("[data-artifact-card]").last(), "[data-artifact-card] for [qa:artifact-form]", 15_000);
  const open = card.getByRole("button", { name: /^Open / });
  const whileStreaming = await eventually(
    async () => ({
      streaming: (await card.getAttribute("data-streaming")) === "true",
      openDisabled: await open.isDisabled().catch(() => null),
      busy: (await card.locator('[class*="animate-orbit"]').count()) > 0,
    }),
    (state) => state.streaming,
    { timeoutMs: 5_000, what: "the card to show streaming" },
  ).catch((error) => ({ error: error.message }));
  step(`${label}: while streaming Open is disabled and the mark is busy`, whileStreaming.streaming && whileStreaming.openDisabled === true && whileStreaming.busy, JSON.stringify(whileStreaming));
  await eventually(() => card.getAttribute("data-streaming"), (value) => value !== "true", { timeoutMs: 15_000, what: "the card to stop streaming" });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 15_000 });
  const cardText = await card.innerText();
  const replyText = await lastReply(page).innerText();
  step(
    `${label}: the artifact card shows Signup form, HTML, and no raw code`,
    cardText.includes("Signup form") && cardText.includes("HTML") && !replyText.includes("<form>") && !replyText.includes("<title>"),
    `card ${JSON.stringify(cardText)}, reply ${JSON.stringify(replyText.slice(0, 120))}`,
  );
  const openName = await open.getAttribute("aria-label");
  step(`${label}: Open is named Open Signup form and Edit code shows`, openName === "Open Signup form" && (await open.innerText()).trim() === "Open" && (await card.getByRole("button", { name: "Edit code" }).count()) === 1, `open ${JSON.stringify(openName)}`);
  if (label === "1440") await shot("artifact-card");

  await open.click();
  const dark = await frameStyle(page);
  const header = await dark.panel.innerText();
  step(`${label}: the panel header shows Signup form`, header.includes("Signup form"), JSON.stringify(header.slice(0, 120)));
  step(
    `${label}: the preview paints with Orbit's background, a sans font, and Orbit's radius`,
    dark.style.background === dark.app.background && !/times/i.test(dark.style.font) && dark.style.radius === dark.app.radius,
    `frame ${JSON.stringify(dark.style)}, app ${JSON.stringify(dark.app)}`,
  );
  if (label === "1440") await shot("artifact-dark");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), dark.panel.getByRole("button", { name: "Download" }).click()]);
  step(`${label}: Download suggests signup-form.html`, download.suggestedFilename() === "signup-form.html", download.suggestedFilename());
  await download.cancel().catch(() => {});

  const saved = await (await page.request.get(`${origin}/api/chats/${chatId}`)).json();
  const fenced = strings(saved).filter((text) => text.includes("```html")).at(-1) ?? "";
  const source = /```html\n([\s\S]*?)\n?```/.exec(fenced)?.[1] ?? "";
  await dark.panel.getByRole("tab", { name: "Code" }).click();
  const code = dark.panel.getByRole("tabpanel").locator("code").first();
  await code.waitFor({ timeout: 5_000 });
  const codeText = await code.textContent();
  const tokens = await code.locator("span.token").count();
  step(`${label}: the Code tab is highlighted and its text matches the source`, tokens > 0 && source !== "" && codeText.replace(/\n$/, "") === source, `tokens ${tokens}, source ${source.length} chars, code ${codeText.length} chars`);
  if (label === "1440") await shot("code-tab");

  const { theme } = await (await page.request.get(`${origin}/api/preferences`)).json();
  await page.request.patch(`${origin}/api/preferences`, { data: { theme: "light" } });
  try {
    await page.reload();
    const light = await frameStyle(page);
    step(
      `${label}: the light theme paints the preview light with dark text`,
      luminance(light.style.background) > 0.8 && luminance(light.style.color) < 0.4 && light.style.background === light.app.background,
      `frame ${JSON.stringify(light.style)}, app ${JSON.stringify(light.app)}`,
    );
    if (label === "1440") await shot("artifact-light");
    await light.panel.getByRole("button", { name: "Close" }).click();
    await light.panel.waitFor({ state: "hidden", timeout: 5_000 });
  } finally {
    await page.request.patch(`${origin}/api/preferences`, { data: { theme: theme ?? "dark" } });
  }
  await page.reload();
  await page.getByPlaceholder("Ask anything").waitFor({ timeout: 15_000 });
}

async function checkWrap(page, { label, step, shot }) {
  await sendPrompt(page, "[qa:wide-code] show the script");
  await replyDone(page, "Line 15 is the wide one.");
  const reply = lastReply(page);
  const sizes = () =>
    reply.locator("pre").first().evaluate((pre) => {
      let scroller = pre;
      while (scroller && !/auto|scroll|hidden/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
      return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth };
    });
  const before = await sizes();
  const wrap = await need(reply.getByRole("button", { name: "Wrap", exact: true }), "Wrap button on the Python block", 5_000);
  const pressedBefore = await wrap.getAttribute("aria-pressed");
  await wrap.click();
  const after = await eventually(sizes, (value) => value.scrollWidth <= value.clientWidth, { timeoutMs: 5_000, what: "the code to wrap" }).catch(() => sizes());
  step(
    `${label}: Wrap turns a sideways-scrolling block into a wrapped one`,
    before.scrollWidth > before.clientWidth && pressedBefore === "false" && (await wrap.getAttribute("aria-pressed")) === "true" && after.scrollWidth <= after.clientWidth,
    `before ${JSON.stringify(before)} pressed ${pressedBefore}, after ${JSON.stringify(after)} pressed ${await wrap.getAttribute("aria-pressed")}`,
  );
  if (label === "390") {
    await reply.locator("pre").first().scrollIntoViewIfNeeded();
    await shot("wrap-390");
  }
}

async function checkPalette(page, { label, step, shot }) {
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.waitFor({ timeout: 5_000 });
  const results = {};
  for (const query of ["firewall", "deploy"]) {
    await dialog.getByPlaceholder("Search").fill(query);
    await dialog.locator("[cmdk-group-heading]", { hasText: "Messages" }).waitFor({ timeout: 10_000 });
    await eventually(() => dialog.locator("mark").count(), (count) => count > 0, { timeoutMs: 10_000, what: `marked hits for ${query}` }).catch(() => 0);
    results[query] = await dialog.evaluate((root, term) => {
      const dialogBox = root.getBoundingClientRect();
      const items = [...root.querySelectorAll("[cmdk-item]")].map((item) => {
        const rect = item.getBoundingClientRect();
        return { right: rect.right, width: rect.width };
      });
      const group = [...root.querySelectorAll("[cmdk-group]")].find((node) => node.querySelector("[cmdk-group-heading]")?.textContent === "Messages");
      const hits = [...(group?.querySelectorAll("[cmdk-item]") ?? [])].map((item) => {
        const marks = [...item.querySelectorAll("mark")].map((mark) => mark.textContent);
        // The title line has no child elements and the snippet line holds <mark> children. The column around both
        // has a <mark> below it but not as a child, so it is neither line.
        const lines = [...item.querySelectorAll("span")].filter((span) => span.childElementCount === 0 || span.querySelector(":scope > mark"));
        const title = lines[0];
        const text = item.textContent.replace(/\[qa:[a-z-]+\]/g, "");
        return {
          marks,
          marked: marks.some((mark) => mark.toLowerCase().includes(term)),
          raw: /[[\]#]/.test(text),
          titleClipped: title ? { ellipsis: getComputedStyle(title).textOverflow === "ellipsis", overflow: title.scrollWidth > title.clientWidth } : null,
          text: item.textContent.slice(0, 120),
        };
      });
      return { dialogWidth: dialogBox.width, dialogRight: dialogBox.right, fits: items.every((item) => item.width <= dialogBox.width + 0.5 && item.right <= dialogBox.right + 0.5), items: items.length, hits };
    }, query);
  }
  const all = [...results.firewall.hits, ...results.deploy.hits];
  step(`${label}: palette rows are no wider than the dialog`, results.firewall.fits && results.deploy.fits, JSON.stringify({ firewall: results.firewall.dialogWidth, items: results.firewall.items, fits: [results.firewall.fits, results.deploy.fits] }));
  step(`${label}: snippets mark the match and show no raw [ ] or #`, all.length > 0 && all.every((hit) => hit.marked && !hit.raw), JSON.stringify(all.map((hit) => ({ text: hit.text, marks: hit.marks, raw: hit.raw }))));
  const longTitle = all.find((hit) => hit.text.startsWith("Deploy notes"));
  step(`${label}: a long chat title truncates with an ellipsis`, Boolean(longTitle?.titleClipped?.ellipsis && longTitle.titleClipped.overflow), JSON.stringify(longTitle ?? null));
  if (label === "390") await shot("palette-390");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

// Which prompt controls show: the rail, and every Prompts button outside it (the rail's own trigger has that name
// too). Exactly one of the two must show at every width.
function promptControls(page) {
  return page.evaluate(() => {
    const shown = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const rail = document.querySelector('nav[aria-label="Prompts in this chat"]');
    const buttons = [...document.querySelectorAll('button[aria-label="Prompts"]')].filter((button) => !button.closest("nav") && shown(button));
    const aside = document.querySelector("aside");
    const thread = window.__viewportOf(document.querySelector("[data-turn-id]"));
    return {
      rail: Boolean(rail && shown(rail)),
      buttons: buttons.map((button) => (button.closest("header") ? "header" : button.closest("[data-jump-strip]") ? "strip" : "elsewhere")),
      sidebar: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      thread: thread ? Math.round(thread.getBoundingClientRect().width) : 0,
    };
  });
}
const exactlyOne = (controls) => controls.rail !== (controls.buttons.length === 1) && controls.buttons.length <= 1;

// After a resize or a sidebar toggle the controls settle within a frame or two, once the sidebar width transition ends.
async function settledControls(page, expected) {
  return eventually(() => promptControls(page), (controls) => exactlyOne(controls) && expected(controls), { timeoutMs: 3_000, what: "the prompt controls to settle" }).catch(() => promptControls(page));
}

// The tick rail needs a thread 52rem wide. Narrower, a Prompts button opens the same list in the sheet: in the header
// while the header shows, and in the Jump to latest strip while the open sidebar hides the header (768px and up).
async function checkPromptsWidths(page, { step, shot }) {
  const sidebarToggle = async (name) => {
    await page.getByRole("button", { name, exact: true }).first().click();
  };
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    const open = await settledControls(page, (controls) => controls.sidebar > 0 && !controls.rail);
    step("1024 with the sidebar open: the rail does not fit and exactly one Prompts button shows", open.sidebar > 0 && !open.rail && exactlyOne(open), JSON.stringify(open));
    await shot("prompts-1024");
    const sheet = page.getByRole("dialog", { name: "Prompts" });
    let opened = false;
    if (open.buttons.length === 1) {
      await page.locator('header button[aria-label="Prompts"]:visible, [data-jump-strip] button[aria-label="Prompts"]:visible').first().click();
      opened = await visible(sheet, 5_000);
    }
    const rows = opened ? await sheet.getByRole("button").filter({ hasText: /\S/ }).count() : 0;
    if (opened) await sheet.getByRole("button").filter({ hasText: "Fold line 1 " }).first().click();
    const landed = opened
      ? await eventually(
          () => page.evaluate(() => ({ sheet: document.querySelector('[role="dialog"]') !== null, focused: document.activeElement?.closest("[data-turn-id]") === document.querySelector("[data-turn-id]") })),
          (state) => !state.sheet && state.focused,
          { timeoutMs: 5_000, what: "the sheet to close and the first prompt to take focus" },
        ).catch(() => null)
      : null;
    step("1024 with the sidebar open: the Prompts button opens the sheet and a pick focuses the prompt", opened && rows >= 5 && Boolean(landed), `sheet ${opened}, rows ${rows}, landed ${JSON.stringify(landed)}`);

    await sidebarToggle("Close sidebar");
    const closed = await settledControls(page, (controls) => controls.sidebar === 0);
    step("1024 with the sidebar closed: the thread fits the rail and no Prompts button shows", closed.sidebar === 0 && closed.rail && closed.buttons.length === 0, JSON.stringify(closed));
    await page.setViewportSize({ width: 800, height: 1024 });
    const narrow = await settledControls(page, (controls) => !controls.rail);
    step("800 with the sidebar closed: the header Prompts button shows instead of the rail", !narrow.rail && narrow.buttons.length === 1 && narrow.buttons[0] === "header", JSON.stringify(narrow));
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    if ((await promptControls(page)).sidebar === 0) await sidebarToggle("Open sidebar");
  }
  const back = await settledControls(page, (controls) => controls.sidebar > 0 && controls.rail);
  step("1440 with the sidebar open again: the rail shows and no Prompts button does", back.sidebar > 0 && back.rail && back.buttons.length === 0, JSON.stringify(back));
}

async function checkPrompts(page, { label, touch, step, shot }) {
  await sendPrompt(page, "[qa:plain] fifth prompt");
  await replyDone(page, "pong");
  const headerButton = page.locator("header").getByRole("button", { name: "Prompts", exact: true });
  if (!touch) {
    const desktop = await settledControls(page, (controls) => controls.rail);
    step(`${label}: desktop keeps the prompt rail and shows no Prompts button`, desktop.rail && desktop.buttons.length === 0, JSON.stringify(desktop));
    await checkPromptsWidths(page, { step, shot });
    return;
  }
  await (await need(headerButton, "header Prompts button")).click();
  const sheet = page.getByRole("dialog", { name: "Prompts" });
  await sheet.waitFor({ timeout: 5_000 });
  const rows = await sheet.getByRole("button").evaluateAll((buttons) => buttons.map((button) => ({ text: button.textContent.trim().slice(0, 40), current: button.getAttribute("aria-current"), height: button.getBoundingClientRect().height })));
  const promptRows = rows.filter((row) => row.text.length > 0 && row.text !== "Close");
  step(
    `${label}: the Prompts sheet lists five prompts and marks the current one`,
    promptRows.length === 5 && promptRows.filter((row) => row.current === "location").length === 1 && promptRows.every((row) => row.height >= 43.5),
    JSON.stringify(promptRows),
  );
  if (label === "390") await shot("prompts-sheet-390");
  await sheet.getByRole("button").filter({ hasText: "Fold line 1 " }).first().click();
  await sheet.waitFor({ state: "hidden", timeout: 5_000 });
  const landed = await eventually(
    () =>
      page.evaluate(() => {
        const first = document.querySelector("[data-turn-id]");
        const viewport = window.__viewportOf(first);
        const box = first.getBoundingClientRect();
        const frame = viewport.getBoundingClientRect();
        return { top: box.top - frame.top, inView: box.top >= frame.top - 1 && box.top < frame.bottom, focused: document.activeElement?.closest("[data-turn-id]") === first };
      }),
    (state) => state.inView && state.focused,
    { timeoutMs: 5_000, what: "the first prompt to scroll into view with focus" },
  ).catch(() => null);
  step(`${label}: tapping a prompt closes the sheet, scrolls to it, and focuses it`, Boolean(landed), JSON.stringify(landed));
}

function readDb(run) {
  const db = new Database(path.join(dataDir, "orbit.db"), { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return run(db);
  } finally {
    db.close();
  }
}

async function openMemory(page, origin, viewport, touch) {
  const context = await page.context().browser().newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1, timezoneId: BROWSER_TIME_ZONE });
  await context.addCookies(await page.context().cookies());
  const memory = await context.newPage();
  await memory.goto(`${origin}/memory`);
  await memory.getByRole("heading", { name: "Memory" }).first().waitFor({ timeout: 10_000 });
  return { context, memory };
}

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function runDream(email, env) {
  const result = spawnSync("npm", ["run", "dream", "--", "--user", email], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ORBIT_DATA_DIR: dataDir, ORBIT_QA_TAGS: "1", ...env } });
  const last = `${result.stdout}`.trim().split("\n").filter((line) => line.startsWith("{")).at(-1) ?? "";
  return { code: result.status, last };
}

async function startOllama() {
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts/qa/mock-ollama.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.once("exit", (code) => reject(new Error(`mock-ollama exited ${code}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = /mock-ollama port=(\d+)/.exec(output);
      if (match) resolve(match[1]);
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    }),
  };
}

// A dream without a provider fails. Saving a connection and default model must hide that failure, and the
// finished run's time must be formatted in the browser's time zone.
async function checkMemory({ page, origin, useProvider, step, shot }) {
  const session = await (await page.request.get(`${origin}/api/auth/get-session`)).json();
  if (!session?.user?.id || !session.user.email) throw new Error("The dream fixture requires a signed-in account.");
  const { id: userId, email } = session.user;
  const connections = await (await page.request.get(`${origin}/api/connections`)).json();
  for (const connection of connections) await page.request.delete(`${origin}/api/connections/${connection.id}`);
  const today = localDate();
  const db = new Database(path.join(dataDir, "orbit.db"));
  try {
    db.pragma("busy_timeout = 5000");
    // The server's start-up dream can already have written today's run, and a manual run reopens only a failed one.
    db.prepare("DELETE FROM memory_runs WHERE user_id = ? AND date = ? AND state != 'running'").run(userId, today);
  } finally {
    db.close();
  }
  const failed = runDream(email, {});
  step("a dream with no provider fails with No provider is saved", failed.code !== 0 && failed.last.includes("No provider is saved"), `exit ${failed.code} ${failed.last}`);
  await useProvider();

  const stale = await openMemory(page, origin, { width: 1440, height: 900 }, false);
  const staleShown = await stale.memory.getByText("No provider is saved").count();
  step("after saving a connection and default model /memory hides No provider is saved", staleShown === 0, `${staleShown} matches`);
  await stale.context.close();

  const memoryIds = () => readDb((db) => db.prepare("SELECT id FROM memories WHERE user_id = ?").all(userId).map((row) => row.id));
  const kept = new Set(memoryIds());
  const ollama = await startOllama();
  let done;
  try {
    done = runDream(email, { ORBIT_OLLAMA_URL: ollama.url });
  } finally {
    await ollama.stop();
  }
  try {
    await showDreamStatus({ page, origin, step, shot, done, today, userId });
  } finally {
    // The dream saves prompts that carry [qa:...] tags as memories. Later turns would send them to the mock and
    // change its scenario, so delete what this dream added.
    for (const id of memoryIds().filter((id) => !kept.has(id))) await page.request.delete(`${origin}/api/memories/${id}`);
  }
}

async function showDreamStatus({ page, origin, step, shot, done, today, userId }) {
  step("a dream with a provider finishes", done.code === 0 && done.last.includes('"state":"done"'), `exit ${done.code} ${done.last}`);
  const run = readDb((db) => db.prepare("SELECT finished_at AS finishedAt, chat_ids AS chatIds, added, merged FROM memory_runs WHERE user_id = ? AND date = ?").get(userId, today));
  const at = new Date(run.finishedAt);
  const expectedDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: BROWSER_TIME_ZONE }).format(at);
  const [hour, minute] = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: BROWSER_TIME_ZONE }).format(at).split(":").map(Number);
  const chats = JSON.parse(run.chatIds).length;
  const counts = `${chats} ${chats === 1 ? "chat" : "chats"}, ${run.added} added, ${run.merged} merged`;
  for (const { label, viewport, touch } of VIEWPORTS) {
    const { context, memory } = await openMemory(page, origin, viewport, touch);
    try {
      const line = await eventually(() => memory.getByText(/^Last dream /).first().innerText().catch(() => ""), (text) => text !== "", { timeoutMs: 10_000, what: "the Last dream line" }).catch(() => "");
      const match = /^Last dream (\w{3} \d{1,2}), (\d{1,2}):(\d{2})(?:\s*([AP]M))?\. (.*)$/.exec(line.trim());
      const shownHour = !match ? null : match[4] ? (Number(match[2]) % 12) + (match[4] === "PM" ? 12 : 0) : Number(match[2]);
      step(
        `${label}: /memory shows the last dream in the browser's time zone with its counts`,
        Boolean(match) && match[1] === expectedDate && shownHour === hour && Number(match[3]) === minute && match[5] === counts && (await memory.getByText("No provider is saved").count()) === 0,
        `line ${JSON.stringify(line)}, expected ${expectedDate}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}. ${counts}`,
      );
      if (label === "1440") await shot("memory-status", memory);
    } finally {
      await context.close();
    }
  }
}

export default async function threadPolish(context) {
  const { page, origin, shot } = context;
  await context.useProvider();
  await page.context().addInitScript(defineViewportOf);
  await page.context().addInitScript(defineLineBox);
  let palettePrepared = false;
  for (const { label, viewport, touch } of VIEWPORTS) {
    let target = page;
    let phone = null;
    if (touch) {
      phone = await page.context().browser().newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true });
      await phone.addCookies(await page.context().cookies());
      await phone.addInitScript(defineViewportOf);
      await phone.addInitScript(defineLineBox);
      target = await phone.newPage();
    } else {
      await page.setViewportSize(viewport);
    }
    const run = { ...context, page: target, label, touch, shot: (name) => shot(name, target) };
    try {
      const { id } = await (await target.request.post(`${origin}/api/chats`)).json();
      await target.goto(`${origin}/c/${id}`);
      await target.getByPlaceholder("Ask anything").waitFor({ timeout: 15_000 });
      await checkFold(target, run);
      await checkStreaming(target, run);
      await checkJumpStrip(target, run);
      await checkArtifact(target, { ...run, chatId: id });
      await checkWrap(target, run);
      if (!palettePrepared) {
        const created = await (await target.request.post(`${origin}/api/chats`)).json();
        const seed = await phone?.newPage() ?? (await page.context().newPage());
        await seed.goto(`${origin}/c/${created.id}`);
        await sendPrompt(seed, "[qa:markdown] how do I deploy orbit");
        await replyDone(seed, "Back up every night");
        await seed.close();
        const renamed = await target.request.patch(`${origin}/api/chats/${created.id}`, { data: { title: LONG_TITLE } });
        if (renamed.status() !== 200) throw new Error(`PATCH /api/chats/${created.id} answered ${renamed.status()}`);
        palettePrepared = true;
      }
      await checkPalette(target, run);
      await checkPrompts(target, run);
    } finally {
      await phone?.close();
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkMemory(context);
}
