import { eventually } from "../../../../src/lib/eventually.mjs";

// Widget checks for slice 15. Each prompt is sent once at 1440, checked live, then reloaded and checked
// again. The 390 and 360 touch views and the 390 light view open the same saved chats. MEASURE lines feed
// the before and after table; they read the render_ui root, so they also run on the old run-card markup.

const VIEWS = [
  { name: "1440", width: 1440, height: 900, touch: false, theme: "dark" },
  { name: "390", width: 390, height: 844, touch: true, theme: "dark" },
  { name: "360", width: 360, height: 780, touch: true, theme: "dark" },
  { name: "390-light", width: 390, height: 844, touch: true, theme: "light" },
];
const PROMPTS = {
  all: "[qa:all] Show every catalog component.",
  tones: "[qa:tones] Show the team health view.",
  huge: "[qa:huge] Render the huge table.",
  invalid: "[qa:invalid] Render invalid props.",
  long: "[qa:long] Render long text.",
};
const STATUS_WORDS = /Generated UI|\b(Running|Succeeded|Failed|Cancelled)\b/;
const CALLOUT_TOKENS = { info: "--info", warning: "--warning", success: "--positive" };
const TONE_TOKENS = { positive: "--positive", negative: "--negative" };
const ROW_CAP = 12;
const HUGE_ROWS = 220;
const ROOT = '[data-tool-name="render_ui"]';

// Every finite animation ends and no scroller moves between two reads, so boxes and scroll offsets are final.
async function settle(page) {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  let last = null;
  await eventually(
    () => page.evaluate(() => [window.scrollY, ...[...document.querySelectorAll("*")].filter((el) => el.scrollTop > 0 || el.scrollLeft > 0).map((el) => `${el.scrollTop}/${el.scrollLeft}`)].join(",")),
    (now) => {
      const same = now === last;
      last = now;
      return same;
    },
    { timeoutMs: 5_000, intervalMs: 150, what: "the page to stop scrolling" },
  );
}

// Records whether the render_ui root ever showed its running state, a skeleton, and the hidden Building view status.
async function watchStream(page) {
  await page.evaluate((root) => {
    const seen = { running: false, skeleton: false, building: false };
    const read = () => {
      for (const node of document.querySelectorAll(root)) {
        if (node.getAttribute("data-tool-status") === "running" || node.querySelector('[data-tool-status="running"]')) seen.running = true;
        if (node.querySelector('[data-slot="skeleton"]')) seen.skeleton = true;
        if ([...node.querySelectorAll('[role="status"]')].some((el) => el.textContent.trim() === "Building view")) seen.building = true;
      }
    };
    const observer = new MutationObserver(read);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__widgetStream = { seen, stop: () => observer.disconnect() };
  }, ROOT);
}

async function streamSeen(page) {
  return page.evaluate(() => {
    window.__widgetStream?.stop();
    return window.__widgetStream?.seen ?? null;
  });
}

// Shared page-side helpers: visibility, colors through a canvas, and token values read from a probe.
function pageHelpers() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (value) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const key = (value) => {
    const c = rgba(value);
    return `${c.r},${c.g},${c.b},${c.a.toFixed(2)}`;
  };
  const sameColor = (a, b) => {
    const x = rgba(a);
    const y = rgba(b);
    return Math.abs(x.r - y.r) <= 1 && Math.abs(x.g - y.g) <= 1 && Math.abs(x.b - y.b) <= 1 && Math.abs(x.a - y.a) <= 0.02;
  };
  const token = (host, name, property = "color") => {
    const probe = document.createElement("span");
    probe.style[property] = `var(${name})`;
    host.append(probe);
    const value = getComputedStyle(probe)[property];
    probe.remove();
    return value;
  };
  // The color a reader sees behind the element: its background over every ancestor's, down to the first opaque one.
  const paint = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color.a > 0) layers.push(color);
      if (color.a >= 1) break;
    }
    let base = layers.length && layers.at(-1).a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) {
      const top = layers.pop();
      base = { r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 };
    }
    return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
  };
  const visible = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const framed =(el, solidOnly = false) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || !visible(el)) return false;
    return ["Top", "Right", "Bottom", "Left"].every((side) => {
      const kind = style[`border${side}Style`];
      return parseFloat(style[`border${side}Width`]) > 0 && kind !== "none" && kind !== "hidden" && (!solidOnly || kind === "solid") && rgba(style[`border${side}Color`]).a > 0;
    });
  };
  const describe = (el) => {
    const marks = [...el.attributes].filter((a) => a.name.startsWith("data-") || a.name === "role").map((a) => `[${a.name}${a.value ? `=${a.value}` : ""}]`).join("");
    const classes = String(el.className?.baseVal ?? el.className ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${el.tagName.toLowerCase()}${marks}${classes ? `.${classes}` : ""}`;
  };
  // The part of the viewport this element's text can show in: every overflow-clipping ancestor cuts it.
  const clipBox = (el) => {
    let box = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.overflowX !== "visible") box = { ...box, left: Math.max(box.left, rect.left), right: Math.min(box.right, rect.right) };
      if (style.overflowY !== "visible") box = { ...box, top: Math.max(box.top, rect.top), bottom: Math.min(box.bottom, rect.bottom) };
      if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
    }
    return box;
  };
  const textNodes = (root) => {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!/\S/.test(node.textContent) || !el || el.closest("script, style, noscript, template, title") || !visible(el)) continue;
      nodes.push(node);
    }
    return nodes;
  };
  return { rgba, key, sameColor, token, paint, visible, framed, describe, clipBox, textNodes };
}

// [qa:all]: the header, the surface, framed boxes, number format, the text colors, and the border depth.
function readAll(root, helpers) {
  const h = new Function(`return (${helpers})()`)();
  const reply = root.closest('[data-message-role="assistant"]') ?? root;
  const surfaces = [...root.querySelectorAll("[data-genui]")];
  const surface = surfaces[0] ?? null;
  const scope = surface ?? root;
  const offenders = [...scope.querySelectorAll("*")]
    .filter((el) => !el.closest('[role="textbox"]') && h.framed(el, true))
    .map(h.describe);
  const depthOf = (el) => {
    const chain = [];
    for (let node = el; node && root.contains(node); node = node.parentElement) if (h.framed(node)) chain.push(node);
    return chain;
  };
  let deepest = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!h.framed(el)) continue;
    const chain = depthOf(el);
    if (chain.length > deepest.length) deepest = chain;
  }
  let solidDeepest = 0;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!h.framed(el, true)) continue;
    let count = 0;
    for (let node = el; node && root.contains(node); node = node.parentElement) if (h.framed(node, true)) count += 1;
    solidDeepest = Math.max(solidDeepest, count);
  }
  const colors = new Map();
  for (const node of h.textNodes(root)) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || !h.clipBox(node.parentElement)) continue;
    const color = getComputedStyle(node.parentElement).color;
    const k = h.key(color);
    if (!colors.has(k)) colors.set(k, { color, sample: clean(node.textContent).slice(0, 24) });
  }
  const leaves = [...root.querySelectorAll("*")].filter((el) => el.children.length === 0);
  const budget = leaves.find((el) => clean(el.textContent) === "42,000") ?? null;
  const budgetLabel = [...root.querySelectorAll("dt")].find((el) => clean(el.textContent) === "Budget");
  const budgetValue = budgetLabel?.nextElementSibling ?? null;
  const textbox = root.querySelector('[role="textbox"]');
  return {
    replyText: clean(reply.innerText),
    rootTag: root.tagName.toLowerCase(),
    rootStatus: root.getAttribute("data-tool-status"),
    surfaces: surfaces.length,
    offenders,
    depth: deepest.length,
    depthChain: deepest.reverse().map(h.describe),
    solidDepth: solidDeepest,
    colors: [...colors.values()],
    budget: budget ? { tag: budget.tagName.toLowerCase(), numeric: getComputedStyle(budget).fontVariantNumeric, visible: h.visible(budget) } : null,
    budgetShown: budgetValue ? { text: clean(budgetValue.textContent), numeric: getComputedStyle(budgetValue).fontVariantNumeric } : null,
    textbox: textbox ? { style: getComputedStyle(textbox).borderTopStyle, sides: ["Top", "Right", "Bottom", "Left"].map((side) => getComputedStyle(textbox)[`border${side}Style`]) } : null,
  };
  function clean(text) {
    return (text ?? "").replace(/−/g, "-").replace(/\s+/g, " ").trim();
  }
}

// [qa:tones]: callout rules, metric changes, and the KeyValue numbers.
function readTones(root, helpers) {
  const h = new Function(`return (${helpers})()`)();
  const clean = (text) => (text ?? "").replace(/−/g, "-").replace(/\s+/g, " ").trim();
  const callouts = Object.fromEntries(["info", "warning", "success"].map((tone) => {
    const found = [...root.querySelectorAll(`[data-callout][data-tone="${tone}"]`)];
    const el = found[0];
    const tokenName = { info: "--info", warning: "--warning", success: "--positive" }[tone];
    const expected = h.token(root, tokenName, "backgroundColor");
    const rule = el ? getComputedStyle(el, "::before") : null;
    return [tone, {
      count: found.length,
      rule: rule ? { content: rule.content, background: rule.backgroundColor, width: rule.width } : null,
      expected,
      matches: rule ? rule.content !== "none" && h.sameColor(rule.backgroundColor, expected) : false,
    }];
  }));
  const changes = [...root.querySelectorAll("[data-change]")].map((el) => ({
    text: clean(el.textContent),
    tone: el.getAttribute("data-tone"),
    arrows: [...el.querySelectorAll("svg[data-arrow]")].map((svg) => svg.getAttribute("data-arrow")),
    color: getComputedStyle(el).color,
    positive: h.sameColor(getComputedStyle(el).color, h.token(el, "--positive")),
    negative: h.sameColor(getComputedStyle(el).color, h.token(el, "--negative")),
  }));
  const values = [...root.querySelectorAll("[data-metric-value]")].map((el) => ({ text: clean(el.textContent), numeric: getComputedStyle(el).fontVariantNumeric }));
  const pairs = [...root.querySelectorAll("dt")].map((dt) => {
    const dd = dt.nextElementSibling;
    return { label: clean(dt.textContent), value: clean(dd?.textContent), numeric: dd ? getComputedStyle(dd).fontVariantNumeric : "" };
  });
  const fallback = root.querySelector("[data-genui-fallback]");
  return { callouts, changes, values, pairs, fallback: fallback ? clean(fallback.textContent).slice(0, 160) : null, text: clean(root.innerText).slice(0, 200) };
}

// [qa:huge]: rows, height, the sideways scroller and its end fade, the header fill, and column alignment.
function readHuge(root, helpers) {
  const h = new Function(`return (${helpers})()`)();
  const wrapper = root.querySelector("[data-genui-table]");
  const table = (wrapper ?? root).querySelector("table");
  let scroller = table?.parentElement ?? null;
  while (scroller && scroller !== root && !/auto|scroll/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
  if (scroller === root) scroller = null;
  const fade = scroller?.parentElement?.lastElementChild ?? null;
  const endFade = fade && fade !== scroller && fade.getAttribute("aria-hidden") === "true" ? fade : null;
  const headers = table ? [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim()) : [];
  const header = table?.querySelector("thead th") ?? null;
  const surface = root.querySelector("[data-genui]") ?? root;
  const rows = table ? [...table.querySelectorAll("tbody tr")] : [];
  const align = (name) => {
    const index = headers.indexOf(name);
    return index < 0 ? [] : [...new Set(rows.map((row) => getComputedStyle(row.cells[index]).textAlign))];
  };
  return {
    wrapper: Boolean(wrapper),
    bodyRows: rows.length,
    height: root.getBoundingClientRect().height,
    scroller: scroller ? { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth } : null,
    endFade: endFade ? { opacity: getComputedStyle(endFade).opacity } : null,
    headerBackground: header ? h.key(h.paint(header)) : null,
    surfaceBackground: h.key(h.paint(surface)),
    headerRaised: header !== null && h.key(h.paint(header)) !== h.key(h.paint(surface)),
    align: { Row: align("Row"), Team: align("Team"), Score: align("Score"), Budget: align("Budget") },
  };
}

// [qa:invalid]: the error line and its disclosure.
function readInvalid(root, helpers) {
  const h = new Function(`return (${helpers})()`)();
  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const fallbacks = [...root.querySelectorAll("[data-genui-fallback]")];
  const fallback = fallbacks[0] ?? null;
  const summary = fallback?.matches("details") ? fallback.querySelector(":scope > summary") : null;
  const pres = [...root.querySelectorAll("pre")].filter((pre) => h.visible(pre) && pre.getBoundingClientRect().height > 0);
  return {
    count: fallbacks.length,
    tag: fallback?.tagName.toLowerCase() ?? "",
    open: fallback?.matches("details") ? fallback.open : null,
    summary: summary ? clean(summary.textContent) : null,
    text: clean(root.innerText),
    visiblePre: pres.map((pre) => clean(pre.textContent).slice(0, 80)),
  };
}

// Visible characters inside the viewport and under 13px, on the whole screen and inside the widget.
function smallText(root, helpers) {
  const h = new Function(`return (${helpers})()`)();
  const tally = (scope) => {
    const out = { chars: 0, small: 0 };
    if (!scope) return out;
    const range = document.createRange();
    for (const node of h.textNodes(scope)) {
      const el = node.parentElement;
      const clip = h.clipBox(el);
      if (!clip) continue;
      const small = parseFloat(getComputedStyle(el).fontSize) < 13;
      const inside = (rect) => {
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return rect.width >= 0.5 && rect.height >= 0.5 && x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom;
      };
      range.selectNodeContents(node);
      const whole = range.getBoundingClientRect();
      if (whole.right < clip.left || whole.left > clip.right || whole.bottom < clip.top || whole.top > clip.bottom) continue;
      const text = node.textContent;
      const fully = whole.left >= clip.left && whole.right <= clip.right && whole.top >= clip.top && whole.bottom <= clip.bottom;
      for (let index = 0; index < text.length; index += 1) {
        if (/\s/.test(text[index])) continue;
        if (!fully) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getClientRects()[0];
          if (!rect || !inside(rect)) continue;
        }
        out.chars += 1;
        if (small) out.small += 1;
      }
    }
    return out;
  };
  return { screen: tally(document.body), widget: tally(root), width: window.innerWidth, scrollY: window.scrollY };
}

const helperSource = pageHelpers.toString();
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "n/a");

export default async function widgets({ page, origin, step, shot }) {
  const browser = page.context().browser();
  const cookies = await page.context().cookies();
  const views = [];
  const measure = (line) => console.log(`MEASURE ${line}`);

  async function setTheme(theme) {
    const response = await page.request.patch(`${origin}/api/preferences`, { data: { theme } });
    return step(`PATCH /api/preferences theme=${theme} answers 200`, response.status() === 200, `status ${response.status()}`);
  }

  async function openView(view) {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      isMobile: view.touch, hasTouch: view.touch, reducedMotion: "reduce",
    });
    await context.addCookies(cookies);
    const opened = { ...view, context, page: await context.newPage() };
    views.push(opened);
    return opened;
  }

  async function waitForReply(view, id) {
    await eventually(
      async () => (await (await view.page.request.get(`${origin}/api/chats/${id}`)).json()).messages ?? [],
      (messages) => messages.some(({ message }) => message?.role === "assistant" && message.parts?.some((part) => part.type === "text" && part.text === "Done.")),
      { timeoutMs: 90_000, intervalMs: 250, what: `chat ${id} to save the widget reply` },
    );
    await view.page.locator('[data-message-role="assistant"]').last().getByText("Done.", { exact: true }).waitFor({ timeout: 30_000 });
    await view.page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 30_000 });
  }

  async function send(view, kind) {
    const { id } = await (await view.page.request.post(`${origin}/api/chats`)).json();
    await view.page.goto(`${origin}/c/${id}`);
    const composer = view.page.getByPlaceholder("Ask anything");
    await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the composer to accept input" });
    if (kind === "huge") await watchStream(view.page);
    await composer.fill(PROMPTS[kind]);
    await composer.press("Enter");
    await waitForReply(view, id);
    await settle(view.page);
    return id;
  }

  async function open(view, id) {
    await view.page.goto(`${origin}/c/${id}`);
    await view.page.locator(ROOT).first().waitFor({ timeout: 30_000 });
    await eventually(() => view.page.getByPlaceholder("Ask anything").isEnabled(), Boolean, { timeoutMs: 15_000, what: "the chat page to hydrate" });
    await settle(view.page);
  }

  const rootOf = (view) => view.page.locator('[data-message-role="assistant"]').last().locator(ROOT).first();
  // A viewport shot with the widget's top just below the header, where a reader starts.
  const shotWidget = async (view, name) => {
    await rootOf(view).evaluate((el) => {
      let scroller = el.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const target = scroller ?? document.scrollingElement;
      target.scrollTop += el.getBoundingClientRect().top - (scroller ? scroller.getBoundingClientRect().top : 0) - 72;
    });
    await settle(view.page);
    await shot(name, view.page);
  };

  async function checkAll(view, label) {
    const root = rootOf(view);
    await root.waitFor({ timeout: 20_000 });
    if (!view.touch) await view.page.mouse.move(0, 0);
    const read = await root.evaluate(readAll, helperSource);
    step(`${label}: all shows no Generated UI header and no status word`, !STATUS_WORDS.test(read.replyText), `reply text starts ${JSON.stringify(read.replyText.slice(0, 80))}`);
    step(`${label}: all draws exactly one [data-genui] surface`, read.surfaces === 1, `${read.surfaces} surfaces; root is ${read.rootTag}`);
    step(`${label}: nothing inside the surface has a solid border on four sides but the editable text`, read.surfaces === 1 && read.offenders.length === 0, `${read.surfaces === 1 ? "" : "no surface, so checked the whole root; "}framed: ${read.offenders.join(", ") || "none"}`);
    step(`${label}: 42,000 shows in tabular figures`, read.budget !== null && read.budget.visible && /tabular-nums/.test(read.budget.numeric), `Budget shows ${JSON.stringify(read.budgetShown)}`);
    step(`${label}: the editable text has a dashed border at rest`, read.textbox !== null && read.textbox.sides.every((side) => side === "dashed"), `border ${read.textbox?.sides.join(" ") ?? "no textbox"}`);
    const textbox = root.locator('[role="textbox"]').first();
    if (await textbox.count()) {
      await textbox.focus();
      const focused = await eventually(
        () => textbox.evaluate((el) => ["Top", "Right", "Bottom", "Left"].map((side) => getComputedStyle(el)[`border${side}Style`])),
        (sides) => sides.every((side) => side === "solid"),
        { timeoutMs: 2_000, what: "the focused editable text to draw a solid border" },
      ).catch((error) => error.message.slice(-60));
      step(`${label}: the editable text border turns solid on focus`, Array.isArray(focused), `border ${focused}`);
      if (!view.touch) {
        await view.page.keyboard.press("Tab");
        const ring = await eventually(
          () => view.page.evaluate(() => {
            const el = document.activeElement;
            const style = getComputedStyle(el);
            return { tag: el.tagName.toLowerCase(), text: el.textContent.trim(), visibleFocus: el.matches(":focus-visible"), shadow: style.boxShadow, outline: `${style.outlineStyle} ${style.outlineWidth}` };
          }),
          (state) => state.tag === "button" && state.text === "Save note" && state.visibleFocus && state.shadow !== "none",
          { timeoutMs: 2_000, what: "Save note to show a focus ring" },
        ).catch((error) => error.message.replace(/^.*Last value read: /s, ""));
        step(`${label}: Save note is a button with a focus ring after Tab`, typeof ring === "object", `focus ${ring}`);
      }
      await view.page.evaluate(() => document.activeElement?.blur());
    } else {
      step(`${label}: the editable text border turns solid on focus`, false, "no [role=textbox]");
    }
    return read;
  }

  async function checkTones(view, label) {
    const root = rootOf(view);
    await root.waitFor({ timeout: 20_000 });
    const read = await root.evaluate(readTones, helperSource);
    for (const [tone, callout] of Object.entries(read.callouts)) {
      step(`${label}: the ${tone} callout rule is ${CALLOUT_TOKENS[tone]}`, callout.count === 1 && callout.matches, callout.count ? `rule ${JSON.stringify(callout.rule)}, token ${callout.expected}` : `no [data-callout][data-tone=${tone}]; fallback ${JSON.stringify(read.fallback)}; text ${JSON.stringify(read.text)}`);
    }
    const change = (text) => read.changes.find((entry) => entry.text.includes(text));
    const expectChange = (text, tone, arrow) => {
      const found = change(text);
      step(`${label}: the ${text} change is ${tone} with ${arrow === "up" ? "an" : "a"} ${arrow} arrow`, found !== undefined && found.tone === tone && found.arrows.length === 1 && found.arrows[0] === arrow, found ? JSON.stringify(found) : `no [data-change] with ${text}; changes ${JSON.stringify(read.changes)}`);
    };
    expectChange("+12%", "positive", "up");
    expectChange("-3.5", "negative", "down");
    expectChange("-8%", "positive", "down");
    const colored = read.changes.length === 3 && read.changes.every((entry) => entry[entry.tone] === true);
    step(`${label}: each change is colored with ${Object.values(TONE_TOKENS).join(" or ")} by its tone`, colored, JSON.stringify(read.changes.map(({ text, tone, color }) => ({ text, tone, color }))));
    step(`${label}: metric values use tabular figures`, read.values.length === 3 && read.values.every((value) => /tabular-nums/.test(value.numeric)), JSON.stringify(read.values));
    const pair = (name) => read.pairs.find((entry) => entry.label === name);
    step(`${label}: Budget shows 42,000 and Year shows 2026 with no comma`, pair("Budget")?.value === "42,000" && pair("Year")?.value === "2026" && /tabular-nums/.test(pair("Year")?.numeric ?? ""), JSON.stringify(read.pairs));
    return read;
  }

  async function checkHuge(view, label) {
    const root = rootOf(view);
    await root.waitFor({ timeout: 20_000 });
    const read = await root.evaluate(readHuge, helperSource);
    measure(`(a) huge render_ui height ${view.name}: ${Math.round(read.height)}px (${read.bodyRows} body rows)`);
    step(`${label}: huge shows ${ROW_CAP} body rows`, read.wrapper && read.bodyRows === ROW_CAP, `${read.wrapper ? "" : "no [data-genui-table]; "}${read.bodyRows} body rows`);
    if (view.width === 390) step(`${label}: huge is under 900px tall`, read.height < 900, `${Math.round(read.height)}px`);
    const fade = await eventually(
      () => root.evaluate(readHuge, helperSource),
      (now) => now.scroller !== null && now.scroller.scrollWidth > now.scroller.clientWidth && now.endFade?.opacity === "1",
      { timeoutMs: 2_000, what: "the table to scroll sideways under a right fade" },
    ).then(() => "", (error) => error.message.replace(/^.*Last value read: /s, "").slice(0, 300));
    step(`${label}: the table scrolls sideways under a right fade`, fade === "", `scroller ${JSON.stringify(read.scroller)}, end fade ${JSON.stringify(read.endFade)}`);
    step(`${label}: the header row has a fill apart from the surface`, read.headerRaised, `header ${read.headerBackground}, surface ${read.surfaceBackground}`);
    const right = (values) => values.length > 0 && values.every((value) => value === "right");
    step(`${label}: Score and Budget cells are right-aligned and Team cells are not`, right(read.align.Score) && right(read.align.Budget) && read.align.Team.length > 0 && !read.align.Team.includes("right"), JSON.stringify(read.align));
    const showAll = root.getByRole("button", { name: `Show all ${HUGE_ROWS} rows`, exact: true });
    const expandedShot = `huge-expanded-${label.replace(/ /g, "-")}`;
    if (!(await showAll.count())) {
      step(`${label}: Show all ${HUGE_ROWS} rows shows ${HUGE_ROWS} rows`, false, `no Show all ${HUGE_ROWS} rows button; ${read.bodyRows} rows render`);
      await shotWidget(view, expandedShot);
    } else {
      if (view.touch) {
        const hit = await showAll.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const grown = after.content !== "none" && after.position === "absolute" ? box.height - parseFloat(after.top) - parseFloat(after.bottom) : box.height;
          return { height: Math.max(box.height, grown), width: box.width, surface: el.closest("[data-genui]")?.getBoundingClientRect().width ?? 0 };
        });
        step(`${label}: Show all ${HUGE_ROWS} rows has a 44px hit area`, hit.height >= 44, JSON.stringify(hit));
      }
      await (view.touch ? showAll.tap() : showAll.click());
      const expanded = await eventually(() => root.locator("tbody tr").count(), (count) => count === HUGE_ROWS, { timeoutMs: 5_000, what: `${HUGE_ROWS} rows` }).catch(() => -1);
      step(`${label}: Show all ${HUGE_ROWS} rows shows ${HUGE_ROWS} rows`, expanded === HUGE_ROWS, `${await root.locator("tbody tr").count()} rows`);
      await shotWidget(view, expandedShot);
      const fewer = root.getByRole("button", { name: "Show fewer", exact: true });
      if (await fewer.count()) {
        await (view.touch ? fewer.tap() : fewer.click());
        const collapsed = await eventually(() => root.locator("tbody tr").count(), (count) => count === ROW_CAP, { timeoutMs: 5_000, what: `${ROW_CAP} rows` }).catch(() => -1);
        step(`${label}: Show fewer returns to ${ROW_CAP} rows`, collapsed === ROW_CAP && (await showAll.count()) === 1, `${await root.locator("tbody tr").count()} rows`);
      } else {
        step(`${label}: Show fewer returns to ${ROW_CAP} rows`, false, "no Show fewer button");
      }
    }
    if (view.touch) {
      const page = await root.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
      step(`${label}: huge does not scroll the page sideways`, page.scrollWidth <= page.width, JSON.stringify(page));
    }
    return read;
  }

  async function checkInvalid(view, label, detailsShot) {
    const root = rootOf(view);
    await root.waitFor({ timeout: 20_000 });
    const read = await root.evaluate(readInvalid, helperSource);
    step(`${label}: invalid shows one closed error line that says Could not show this view`, read.count === 1 && read.tag === "details" && read.open === false && /Could not show this view/.test(read.summary ?? "") && /Details/.test(read.summary ?? ""), `fallback ${read.count}x ${read.tag}${read.open ? "[open]" : ""}, summary ${JSON.stringify(read.summary)}`);
    step(`${label}: no JSON shows before Details opens`, read.visiblePre.length === 0 && !read.text.includes('"elements"'), `visible pre ${JSON.stringify(read.visiblePre)}`);
    const summary = root.locator("details[data-genui-fallback] > summary");
    if (await summary.count()) {
      await (view.touch ? summary.tap() : summary.click());
      const opened = await eventually(
        () => root.evaluate(readInvalid, helperSource),
        (now) => now.open === true && now.visiblePre.some((text) => text.includes('"elements"')),
        { timeoutMs: 3_000, what: "Details to show the JSON" },
      ).catch(() => null);
      const after = opened ?? (await root.evaluate(readInvalid, helperSource));
      step(`${label}: opening Details shows the error path and the JSON`, opened !== null && after.text.includes("elements.card.props.title"), `open ${after.open}, pre ${JSON.stringify(after.visiblePre)}`);
    } else {
      step(`${label}: opening Details shows the error path and the JSON`, false, "no details[data-genui-fallback] summary to open");
    }
    await shotWidget(view, detailsShot);
  }

  async function checkLong(view, label) {
    await rootOf(view).waitFor({ timeout: 20_000 });
    const page = await view.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, width: document.documentElement.clientWidth }));
    step(`${label}: long does not scroll the page sideways`, page.scrollWidth <= page.width && page.bodyWidth <= page.width, JSON.stringify(page));
  }

  async function measureSmall(view) {
    const read = await rootOf(view).evaluate(smallText, helperSource);
    measure(`(c) invalid screen text under 13px at ${view.name}: ${pct(read.screen.small, read.screen.chars)} (${read.screen.small}/${read.screen.chars} chars); inside the widget ${pct(read.widget.small, read.widget.chars)} (${read.widget.small}/${read.widget.chars}); scrollY ${read.scrollY}`);
  }

  function measureAll(view, read) {
    measure(`(b) all border depth at ${view.name}: ${read.depth} framed boxes deep (solid only ${read.solidDepth}); chain ${read.depthChain.join(" > ") || "none"}`);
    measure(`(d) all text colors at ${view.name}: ${read.colors.length} (${read.colors.map(({ color, sample }) => `${color} "${sample}"`).join("; ")})`);
  }

  const chats = {};
  try {
    await setTheme("dark");
    const desk = await openView(VIEWS[0]);

    // 1440, live: each prompt in its own chat, checked as it lands.
    chats.all = await send(desk, "all");
    const all = await checkAll(desk, "1440");
    measureAll(desk, all);
    await shotWidget(desk, "all-1440");

    chats.tones = await send(desk, "tones");
    await checkTones(desk, "1440");
    await shotWidget(desk, "tones-1440");

    chats.huge = await send(desk, "huge");
    const seen = await streamSeen(desk.page);
    step("1440: huge shows a skeleton and a hidden Building view status while the spec streams", seen?.skeleton === true && seen?.building === true, JSON.stringify(seen));
    await shotWidget(desk, "huge-1440");
    await checkHuge(desk, "1440");

    // The error screen is measured and shot as a fresh load leaves it, before anything scrolls.
    chats.invalid = await send(desk, "invalid");
    await open(desk, chats.invalid);
    await measureSmall(desk);
    await shot("invalid-1440", desk.page);
    await checkInvalid(desk, "1440", "invalid-details");

    chats.long = await send(desk, "long");
    await checkLong(desk, "1440");
    await shotWidget(desk, "long-1440");

    // Step 6: a reload keeps steps 1 to 3.
    await open(desk, chats.all);
    await checkAll(desk, "1440 reload");
    await shotWidget(desk, "all-1440-reloaded");
    await open(desk, chats.tones);
    await checkTones(desk, "1440 reload");
    await open(desk, chats.huge);
    await checkHuge(desk, "1440 reload");

    for (const view of VIEWS.slice(1)) {
      if (view.theme !== "dark") await setTheme(view.theme);
      const phone = await openView(view);
      const scheme = await phone.page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches }));
      const label = `${view.name} touch`;
      await open(phone, chats.all);
      const scheme2 = await phone.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      step(`${label}: the page uses the ${view.theme} theme on a coarse pointer`, scheme.coarse && scheme2.includes(view.theme), `colorScheme ${scheme2}, coarse ${scheme.coarse}`);
      const allRead = await checkAll(phone, label);
      if (view.name === "390-light") measureAll(phone, allRead);
      await shotWidget(phone, `all-${view.name}`);

      await open(phone, chats.tones);
      await checkTones(phone, label);
      await shotWidget(phone, `tones-${view.name}`);

      await open(phone, chats.huge);
      await shotWidget(phone, `huge-${view.name}`);
      await checkHuge(phone, label);

      await open(phone, chats.invalid);
      if (view.name === "390") await measureSmall(phone);
      await shot(`invalid-${view.name}`, phone.page);
      await checkInvalid(phone, label, `invalid-details-${view.name}`);

      await open(phone, chats.long);
      await checkLong(phone, label);
      await shotWidget(phone, `long-${view.name}`);
    }
  } finally {
    for (const view of views) await view.context.close().catch(() => {});
    await setTheme("dark");
  }
}
