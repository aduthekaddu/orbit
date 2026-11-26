import fs from "node:fs";
import path from "node:path";
import { eventually } from "../../../../src/lib/eventually.mjs";

// Reading checks for long replies (slice 14). Theme passes run at text size md and check prose, headings,
// line length, contrast, and sideways scroll. Text size passes run in dark and check root size, line height,
// input sizes, and small text, which do not depend on the theme. ORBIT_READING_SWEEP=1 only measures line
// length at 34 to 40rem and prints it.

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, touch: false },
  { name: "390", width: 390, height: 844, touch: true },
  { name: "360", width: 360, height: 780, touch: true },
];
const THEMES = ["dark", "dim", "light", "system"];
const TEXT_SIZES = [["sm", 15], ["md", 16], ["lg", 18], ["xl", 20]];
const DEFAULTS = { theme: "dark", textSize: "md", replyFont: "sans", chatWidth: "normal", accent: "sun" };
const SWEEP_REM = [34, 35, 36, 37, 38, 39, 40];
const PROMPT = "[qa:markdown] Write a deploy guide for Orbit.";
// Saved so the memory page has text to measure, and deleted again so later scenarios on this server never recall them.
const MEMORY_NOTES = ["I deploy Orbit with Caddy on a small server", "My backups run every night at two"];
const LAST_WORDS = "only a guess about the future";
// The tour's method: characters per line is the box width over the mean character width of this string in
// the same font. It reads about 100 for 14px Geist in the 680px column on main, as the tour did.
const SAMPLE = "The quick brown fox jumps over the lazy dog";
const SEARCH = "Caddy";

const near = (a, b) => Math.abs(a - b) < 0.05;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? NaN : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percent = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "n/a");

async function waitForReply(page, origin, id) {
  await eventually(
    async () => JSON.stringify(await (await page.request.get(`${origin}/api/chats/${id}`)).json()),
    (body) => body.includes(LAST_WORDS),
    { timeoutMs: 60_000, what: `chat ${id} to store the markdown reply`, intervalMs: 250 },
  );
}

async function send(page, origin, text, done) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the composer to accept input" });
  await composer.fill(text);
  await composer.press("Enter");
  await page.locator('[data-message-role="assistant"]').last().getByText(done).first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 30_000 });
  return id;
}

// Every finite animation ends, so opacity and position are final when the page is read.
async function settle(page) {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
}

// Reads every rendered text node under the root: size, contrast against the background found by walking
// ancestors, and the inputs. Text clipped by an overflow-hidden box, sr-only text, and transparent text
// do not count. Text below the fold of a scroll container does count, because a scroll reaches it.
function scanPage(rootSelector) {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  const out = {
    missing: !root, chars: 0, le14: 0, lt13: 0, small: [], lowContrast: [], inputs: [],
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
  };
  if (!root) return out;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const parsed = new Map();
  const rgba = (value) => {
    if (!parsed.has(value)) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      parsed.set(value, { r, g, b, a: a / 255 });
    }
    return parsed.get(value);
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const canvasColor = (() => {
    for (const node of [document.documentElement, document.body]) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color.a >= 1) return color;
    }
    return /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  })();
  const backgrounds = new Map();
  const background = (el) => {
    if (backgrounds.has(el)) return backgrounds.get(el);
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color.a > 0) layers.push(color);
      if (color.a >= 1) break;
    }
    let base = layers.length && layers.at(-1).a >= 1 ? layers.pop() : canvasColor;
    while (layers.length) base = over(layers.pop(), base);
    backgrounds.set(el, base);
    return base;
  };
  const opacity = (el) => {
    let value = 1;
    for (let node = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const clipped = (el, rect) => {
    let x = true;
    let y = true;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const hides = /hidden|clip/;
      if ((hides.test(style.overflowX) || hides.test(style.overflowY)) && (box.width <= 1 || box.height <= 1)) return true;
      if (style.clip !== "auto" && style.position === "absolute") return true;
      if (x && hides.test(style.overflowX) && (rect.right <= box.left + 0.5 || rect.left >= box.right - 0.5)) return true;
      if (y && hides.test(style.overflowY) && (rect.bottom <= box.top + 0.5 || rect.top >= box.bottom - 0.5)) return true;
      if (/auto|scroll/.test(style.overflowX)) x = false;
      if (/auto|scroll/.test(style.overflowY)) y = false;
      if (!x && !y) return false;
    }
    return false;
  };
  const describe = (el) => {
    const classes = String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
  };
  const visible = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const smallSeen = new Set();
  const contrastSeen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\s+/g, "");
    const el = node.parentElement;
    if (!text || !el || el.closest("script, style, noscript, template, title") || !visible(el)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.right <= 0 || rect.bottom <= -window.scrollY || clipped(el, rect)) continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    const snippet = node.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
    out.chars += text.length;
    if (size <= 14) out.le14 += text.length;
    if (size < 13 && !el.closest("kbd")) {
      out.lt13 += text.length;
      if (!smallSeen.has(el)) {
        smallSeen.add(el);
        out.small.push(`${size}px ${describe(el)} "${snippet}"`);
      }
    }
    if (contrastSeen.has(el) || el.closest(":disabled, [aria-disabled='true']")) continue;
    contrastSeen.add(el);
    const bg = background(el);
    const ink = rgba(style.color);
    const fg = over({ ...ink, a: ink.a * opacity(el) }, bg);
    const ratio = contrast(fg, bg);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.lowContrast.push(`${ratio.toFixed(2)}<${need} ${hex(fg)} on ${hex(bg)} ${size}px ${describe(el)} "${snippet}"`);
  }

  for (const el of root.querySelectorAll("input, textarea, select")) {
    if (/^(hidden|checkbox|radio|range|button|submit|reset|file|color|image)$/.test(el.type) || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1 || clipped(el, rect)) continue;
    const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.id || el.name || el.type;
    out.inputs.push({ name: `${el.tagName.toLowerCase()}[${name}]`, size: parseFloat(getComputedStyle(el).fontSize) });
  }
  return out;
}

// Reads the roles in the tour table from the chat that holds the markdown reply.
function readMarkdown({ sample, lastWords }) {
  const reply = [...document.querySelectorAll('[data-message-role="assistant"]')].find((el) => el.textContent.includes(lastWords));
  if (!reply) return null;
  const firstParagraph = reply.querySelector("p");
  const root = reply.querySelector(".font-reply") ?? firstParagraph.parentElement;
  const font = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      size: parseFloat(style.fontSize), weight: Number(style.fontWeight), color: style.color, family: style.fontFamily,
      lineHeight: parseFloat(style.lineHeight), visible: el.checkVisibility({ checkVisibilityCSS: true }),
    };
  };
  const charWidth = (el) => {
    const probe = document.createElement("span");
    probe.textContent = sample;
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;left:0;top:0";
    el.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width / sample.length;
  };
  const paragraphs = [...root.children].filter((el) => el.tagName === "P");
  const perLine = paragraphs.map((p) => p.getBoundingClientRect().width / charWidth(p));
  // The characters each rendered line really holds, leaving out every paragraph's last, partial line.
  const fullLines = paragraphs.flatMap((p) => {
    const box = p.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(p).lineHeight);
    const counts = new Map();
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.length; index += 1) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const line = Math.floor((rect.top + rect.height / 2 - box.top) / lineHeight);
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, count]) => count).slice(0, -1);
  });
  const composer = document.querySelector('textarea[placeholder="Ask anything"]');
  const turn = document.querySelector("[data-turn-id]");
  const userText = turn && [...turn.querySelectorAll("*")].find((el) => [...el.childNodes].some((child) => child.nodeType === 3 && child.textContent.includes("[qa:markdown]")));
  const language = [...reply.querySelectorAll("span, div")].find((el) => el.children.length === 0 && el.textContent.trim() === "bash");
  return {
    body: { ...font(firstParagraph), width: firstParagraph.getBoundingClientRect().width, perLine, fullLines },
    rootFamily: getComputedStyle(root).fontFamily,
    column: reply.getBoundingClientRect().width,
    headings: ["h1", "h2", "h3", "h4", "h5", "h6", "p"].map((tag) => ({ tag, ...font(tag === "p" ? firstParagraph : root.querySelector(tag)) })),
    user: font(userText),
    composer: font(composer),
    code: font(reply.querySelector("pre")),
    language: font(language),
    chip: font(composer?.closest("form")?.querySelector("[data-model-chip]")),
    groupLabel: font(document.querySelector("aside nav h2")),
  };
}

function serifFontUrls() {
  const urls = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family");
      if (!/serif/i.test(family) || /sans/i.test(family)) continue;
      for (const match of rule.style.getPropertyValue("src").matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        urls.push(new URL(match[1], sheet.href ?? location.href).href);
      }
    }
  }
  return urls;
}

export default async function reading({ page, origin, step, shot }) {
  const browser = page.context().browser();
  const cookies = await page.context().cookies();
  const lines = [];
  const report = (line = "") => {
    lines.push(line);
    console.log(line);
  };
  const evidence = path.join(process.cwd(), ".verify", "evidence", "reading");
  const save = () => {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, "tables.txt"), `${lines.join("\n")}\n`);
  };

  const markdownId = await send(page, origin, PROMPT, LAST_WORDS);
  await waitForReply(page, origin, markdownId);
  const chatUrl = `${origin}/c/${markdownId}`;

  if (process.env.ORBIT_READING_SWEEP === "1") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(chatUrl);
    await page.getByText(LAST_WORDS).waitFor({ timeout: 15_000 });
    await settle(page);
    await page.evaluate((lastWords) => {
      const reply = [...document.querySelectorAll('[data-message-role="assistant"]')].find((el) => el.textContent.includes(lastWords));
      reply.dataset.readingColumn = "";
      (reply.querySelector(".font-reply") ?? reply.querySelector("p").parentElement).dataset.readingRoot = "";
    }, LAST_WORDS);
    const style = await page.addStyleTag({ content: "/* reading sweep */" });
    report("sweep: assistant body forced to 16px with line height 1.65; median approxCharsPerLine over the reply's top-level paragraphs");
    report(`approxCharsPerLine = box width / mean width of "${SAMPLE}"; rendered = median characters on each full rendered line`);
    report("| Column | Box | Median approxCharsPerLine | Median rendered |");
    report("| --- | --- | --- | --- |");
    const rows = [];
    for (const rem of SWEEP_REM) {
      await style.evaluate((node, width) => {
        node.textContent = `[data-reading-root] { font-size: 16px !important; line-height: 1.65 !important; }
[data-reading-column] { max-width: ${width}rem !important; }`;
      }, rem);
      const read = await page.evaluate(readMarkdown, { sample: SAMPLE, lastWords: LAST_WORDS });
      const value = median(read.body.perLine);
      rows.push({ rem, value });
      report(`| ${rem}rem | ${Math.round(read.body.width)}px at ${read.body.size}px/${(read.body.lineHeight / read.body.size).toFixed(2)} | ${value.toFixed(1)} | ${median(read.body.fullLines)} |`);
    }
    const pick = rows.filter((row) => row.value >= 65 && row.value <= 72).at(-1);
    report(`recommended --chat-column: ${pick ? `${pick.rem}rem (median ${pick.value.toFixed(1)})` : "none of 34 to 40rem has a median from 65 to 72"}`);
    save();
    step("sweep measured 34 to 40rem", rows.length === SWEEP_REM.length, `${rows.length} widths`);
    return;
  }

  const emptyId = (await (await page.request.post(`${origin}/api/chats`)).json()).id;
  for (const note of MEMORY_NOTES) {
    await send(page, origin, `[qa:remember] ${note}`, "Saved.");
  }
  const memories = await eventually(
    async () => (await (await page.request.get(`${origin}/api/memories`)).json()).memories ?? [],
    (rows) => rows.length >= 2,
    { timeoutMs: 15_000, what: "two saved memories", intervalMs: 250 },
  ).catch(() => []);
  step("the memory page has two memories to read", memories.length >= 2, `${memories.length} memories`);

  const preferences = await page.request.get(`${origin}/api/preferences`);
  step("GET /api/preferences answers 200", preferences.status() === 200, `status ${preferences.status()}`);
  async function setPreferences(patch) {
    const response = await page.request.patch(`${origin}/api/preferences`, { data: patch });
    const label = Object.entries(patch).map(([key, value]) => `${key}=${value}`).join(" ");
    return step(`PATCH /api/preferences ${label} answers 200`, response.status() === 200, `status ${response.status()}`);
  }

  // Every page these contexts open has replyFont sans; the serif check opens its own context.
  const serifUrls = new Set();
  const views = [];
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.touch, hasTouch: viewport.touch, reducedMotion: "reduce",
    });
    await context.addCookies(cookies);
    const view = await context.newPage();
    const userAgent = await view.evaluate(() => navigator.userAgent);
    views.push({ ...viewport, context, page: view, modifier: /Mac|iPhone|iPad/.test(userAgent) ? "Meta" : "Control" });
  }

  async function openMarkdown(view) {
    await view.page.goto(chatUrl);
    await view.page.getByText(LAST_WORDS).waitFor({ timeout: 15_000 });
    await eventually(() => view.page.getByPlaceholder("Ask anything").isEnabled(), Boolean, { timeoutMs: 15_000, what: "the chat page to hydrate" });
    await settle(view.page);
    for (const url of await view.page.evaluate(serifFontUrls)) serifUrls.add(url);
  }

  async function readPalette(view) {
    const dialog = view.page.getByRole("dialog", { name: "Command palette" });
    await view.page.keyboard.press(`${view.modifier}+KeyK`);
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator("input").fill(SEARCH);
    await dialog.getByText("Messages", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {});
    await settle(view.page);
    const scan = await view.page.evaluate(scanPage, '[role="dialog"]');
    await view.page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
    return scan;
  }

  async function readMemory(view) {
    await view.page.goto(`${origin}/memory`);
    const editor = view.page.getByRole("textbox", { name: "Memory" });
    const edit = view.page.getByRole("button", { name: "Edit" });
    if (await edit.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
      // A click before hydration does nothing, so click until the editor opens.
      await eventually(
        async () => {
          if (await editor.isVisible()) return true;
          await edit.first().click({ timeout: 2_000 }).catch(() => {});
          return editor.isVisible();
        },
        Boolean,
        { timeoutMs: 15_000, what: "the memory editor to open", intervalMs: 250 },
      ).catch(() => {});
    }
    await settle(view.page);
    return view.page.evaluate(scanPage, null);
  }

  // Visits the five pages and returns { name: scan }, plus the markdown roles.
  async function readAll(view, shotName) {
    const scans = {};
    await openMarkdown(view);
    const markdown = await view.page.evaluate(readMarkdown, { sample: SAMPLE, lastWords: LAST_WORDS });
    scans["markdown chat"] = await view.page.evaluate(scanPage, null);
    if (shotName) {
      await view.page.evaluate(() => document.querySelector('[data-message-role="assistant"] h1')?.scrollIntoView({ block: "start" }));
      await shot(shotName, view.page);
    }
    scans["palette results"] = await readPalette(view);
    await view.page.goto(`${origin}/c/${emptyId}`);
    await view.page.getByRole("button", { name: "Make a table", exact: true }).waitFor({ timeout: 15_000 });
    await eventually(() => view.page.getByPlaceholder("Ask anything").isEnabled(), Boolean, { timeoutMs: 15_000, what: "the empty chat to hydrate" });
    await settle(view.page);
    scans["empty chat"] = await view.page.evaluate(scanPage, null);
    await view.page.goto(`${origin}/settings`);
    await view.page.getByRole("button", { name: "Save" }).waitFor({ timeout: 15_000 });
    await settle(view.page);
    scans.settings = await view.page.evaluate(scanPage, null);
    scans.memory = await readMemory(view);
    return { scans, markdown };
  }

  const px = (font) => (font ? `${font.size}px${font.visible ? "" : " (hidden)"}` : "absent");
  const roleRows = [];
  const contrastRows = [];

  try {
    for (const theme of THEMES) {
      await setPreferences({ theme });
      const counts = [];
      for (const view of views) {
        if (theme === "system") await view.page.emulateMedia({ colorScheme: "light" });
        const label = `${theme} ${view.name}`;
        const { scans, markdown } = await readAll(view, `markdown-${view.name}-${theme}`);
        if (!markdown) {
          step(`${label}: the markdown reply renders`, false, "no assistant message with the reply");
          continue;
        }
        const { body, headings } = markdown;
        const ratio = body.lineHeight / body.size;
        const perLine = median(body.perLine);
        step(`${label}: assistant prose is 16px`, body.size === 16, `${body.size}px`);
        step(`${label}: prose line height is 1.6 to 1.7 times its size`, ratio >= 1.6 && ratio <= 1.7, `${body.lineHeight}px / ${body.size}px = ${ratio.toFixed(2)}`);
        if (view.name === "1440") {
          step(`${label}: median characters per line is 65 to 75`, perLine >= 65 && perLine <= 75, `${perLine.toFixed(1)} in a ${Math.round(body.width)}px box`);
        }
        const tuples = headings.map((h) => (h.size ? `${h.size}|${h.weight}|${h.color}` : `missing ${h.tag}`));
        step(
          `${label}: h1 to h6 and p have distinct size, weight, and color`,
          new Set(tuples).size === tuples.length && !tuples.some((t) => t.startsWith("missing")),
          headings.map((h, i) => `${h.tag} ${tuples[i]}`).join(", "),
        );
        const [h1, h2, h3, h4, , , p] = headings;
        step(
          `${label}: h1 to h4 step down in size and stay above body text`,
          h1.size > h2.size && h2.size > h3.size && h3.size > h4.size && h4.size > p.size,
          `h1 ${h1.size}, h2 ${h2.size}, h3 ${h3.size}, h4 ${h4.size}, p ${p.size}`,
        );
        const low = Object.entries(scans).flatMap(([name, scan]) => scan.lowContrast.map((entry) => `${name}: ${entry}`));
        counts.push(low.length);
        step(`${label}: no low-contrast text on markdown chat, empty chat, settings, memory, palette`, low.length === 0, `${low.length} entries: ${low.slice(0, 6).join(" | ")}`);
        if (view.touch) {
          const wide = Object.entries(scans).filter(([, scan]) => scan.scrollWidth > scan.clientWidth + 1);
          step(`${label}: no sideways page scroll`, wide.length === 0, wide.map(([name, scan]) => `${name} ${scan.scrollWidth}>${scan.clientWidth}`).join(", "));
        }
        if (theme === THEMES[0]) {
          roleRows.push({
            view: view.name,
            body: `${body.size}px, ${body.lineHeight}px line, ${Math.round(body.width)}px box, about ${Math.round(perLine)} chars`,
            user: px(markdown.user), composer: px(markdown.composer), code: px(markdown.code), language: px(markdown.language),
            chip: px(markdown.chip), group: px(markdown.groupLabel),
            le14: percent(scans["markdown chat"].le14, scans["markdown chat"].chars),
            lt13: percent(scans.settings.lt13, scans.settings.chars),
            low: low.length,
          });
        }
      }
      contrastRows.push({ theme, counts });
    }

    report(`role table (theme ${THEMES[0]}, text size md; sample "${SAMPLE}")`);
    report(`| Role | ${roleRows.map((row) => row.view).join(" | ")} |`);
    report(`| --- |${roleRows.map(() => " --- |").join("")}`);
    const roles = [
      ["Assistant body", "body"], ["User text", "user"], ["Composer", "composer"], ["Code block", "code"], ["Code language", "language"],
      ["Model chip", "chip"], ["Sidebar group label", "group"], ["Visible characters at 14px or less, markdown chat", "le14"],
      ["Visible characters under 13px, settings", "lt13"], ["Low-contrast text entries, five pages", "low"],
    ];
    for (const [name, key] of roles) report(`| ${name} | ${roleRows.map((row) => row[key]).join(" | ")} |`);
    report();
    report("low-contrast entries per theme (markdown chat, empty chat, settings, memory, palette)");
    report(`| Theme | ${VIEWPORTS.map((v) => v.name).join(" | ")} |`);
    report(`| --- |${VIEWPORTS.map(() => " --- |").join("")}`);
    for (const row of contrastRows) report(`| ${row.theme} | ${row.counts.join(" | ")} |`);
    report();

    await setPreferences({ theme: "dark" });
    for (const view of views) await view.page.emulateMedia({ colorScheme: null });
    report("text sizes (theme dark)");
    report("| Size | Viewport | Root | Prose | Line ratio | Smallest input | Under 13px: markdown, empty, settings, memory, palette |");
    report("| --- | --- | --- | --- | --- | --- | --- |");
    for (const [textSize, rootPx] of TEXT_SIZES) {
      await setPreferences({ textSize });
      for (const view of views) {
        const label = `${textSize} ${view.name}`;
        const { scans, markdown } = await readAll(view, textSize === "xl" && view.name === "360" ? "markdown-360-xl" : null);
        const rootSize = scans["markdown chat"].rootFontSize;
        step(`${label}: root font size is ${rootPx}px`, near(rootSize, rootPx), `${rootSize}px`);
        const ratio = markdown ? markdown.body.lineHeight / markdown.body.size : NaN;
        step(`${label}: prose line height is 1.6 to 1.7 times its size`, ratio >= 1.6 && ratio <= 1.7, markdown ? `${markdown.body.lineHeight}px / ${markdown.body.size}px = ${ratio.toFixed(2)}` : "no reply");
        const inputs = Object.entries(scans).flatMap(([name, scan]) => scan.inputs.map((input) => ({ ...input, page: name })));
        const smallInputs = inputs.filter((input) => input.size < 16);
        const names = new Set(inputs.map((input) => input.name));
        step(
          `${label}: every input, textarea, and select is 16px or larger`,
          inputs.length > 0 && smallInputs.length === 0,
          `${smallInputs.length} of ${inputs.length} under 16px: ${smallInputs.map((input) => `${input.page} ${input.name} ${input.size}px`).join(", ")}`,
        );
        if (view.name === "1440" && textSize === "sm") report(`inputs read: ${[...names].join(", ")}`);
        const small = Object.entries(scans).filter(([, scan]) => scan.lt13 > 0);
        step(
          `${label}: no visible text under 13px outside kbd`,
          small.length === 0,
          small.map(([name, scan]) => `${name} ${scan.lt13} chars: ${scan.small.slice(0, 4).join("; ")}`).join(" | "),
        );
        if (view.touch) {
          const wide = Object.entries(scans).filter(([, scan]) => scan.scrollWidth > scan.clientWidth + 1);
          step(`${label}: no sideways page scroll`, wide.length === 0, wide.map(([name, scan]) => `${name} ${scan.scrollWidth}>${scan.clientWidth}`).join(", "));
        }
        const under = ["markdown chat", "empty chat", "settings", "memory", "palette results"].map((name) => percent(scans[name].lt13, scans[name].chars)).join(", ");
        const smallest = inputs.length ? `${Math.min(...inputs.map((input) => input.size))}px` : "none";
        report(`| ${textSize} | ${view.name} | ${rootSize}px | ${markdown?.body.size}px | ${ratio.toFixed(2)} | ${smallest} | ${under} |`);
      }
    }
    await setPreferences({ textSize: "md" });
    report();

    // Settings previews the Serif option in its own font, so only a context that opens nothing but a chat counts.
    const sans = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await sans.addCookies(cookies);
    const sansFonts = [];
    sans.on("request", (request) => {
      if (/\.woff2(\?|$)/.test(request.url())) sansFonts.push(request.url());
    });
    const sansView = { name: "1440", context: sans, page: await sans.newPage() };
    await openMarkdown(sansView);
    await sansView.page.evaluate(() => document.fonts.ready);
    const serifWhileSans = sansFonts.filter((url) => /serif/i.test(url) || serifUrls.has(url));
    step("a chat page with replyFont sans requests no serif .woff2", serifWhileSans.length === 0, serifWhileSans.join(", ") || `woff2 requests: ${sansFonts.length}`);
    await sans.close();

    await setPreferences({ replyFont: "serif" });
    const serif = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await serif.addCookies(cookies);
    const serifFonts = [];
    serif.on("request", (request) => {
      if (/\.woff2(\?|$)/.test(request.url())) serifFonts.push(request.url());
    });
    const serifView = { name: "1440", context: serif, page: await serif.newPage() };
    await openMarkdown(serifView);
    const serifRead = await serifView.page.evaluate(readMarkdown, { sample: SAMPLE, lastWords: LAST_WORDS });
    await serifView.page.evaluate(() => document.querySelector('[data-message-role="assistant"] h1')?.scrollIntoView({ block: "start" }));
    await shot("markdown-1440-serif", serifView.page);
    report(`serif at 1440: family ${serifRead.rootFamily}; median ${median(serifRead.body.perLine).toFixed(1)} chars per line in a ${Math.round(serifRead.body.width)}px box`);
    const loaded = serifFonts.filter((url) => /serif/i.test(url) || serifUrls.has(url));
    step("replyFont serif requests a serif .woff2 on a chat page", loaded.length > 0, `woff2 requests: ${serifFonts.join(", ") || "none"}`);
    await serif.close();
  } finally {
    const reset = await page.request.patch(`${origin}/api/preferences`, { data: DEFAULTS });
    step("preferences return to the defaults", reset.status() === 200, `status ${reset.status()}`);
    const saved = ((await (await page.request.get(`${origin}/api/memories`)).json()).memories ?? []).filter((row) => MEMORY_NOTES.some((note) => row.text?.includes(note)));
    const removed = await Promise.all(saved.map(async (row) => (await page.request.delete(`${origin}/api/memories/${row.id}`)).status()));
    step("the memories this scenario saved are deleted", removed.every((status) => status === 200), `statuses ${removed.join(", ") || "none saved"}`);
    for (const view of views) await view.context.close();
    save();
  }
}
