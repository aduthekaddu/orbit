import { eventually } from "../../../../src/lib/eventually.mjs";
import { startMockSearxng } from "../../../../scripts/qa/mock-searxng.mjs";

// Tool line checks for slice 15: a search that finishes, a memory save, and a search whose SearXNG is gone,
// all in one chat. Then a reload, a 390 touch view with the line opened by a tap, and a 360 touch view.

const MEMORY = "I deploy to Fly.io";
const RAW_NAMES = new Set(["remember", "forget", "web_search", "render_ui", "run_code", "github_list_issues"]);
const SAFE_REL = "noopener noreferrer nofollow";

// The line as a reader meets it: its root, the status element and its words, the saved text, the tiles, and the
// height of the part that takes a tap.
function readLine(root) {
  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const details = root.matches("details");
  const summary = details ? root.querySelector(":scope > summary") : null;
  const status = root.querySelector('[role="status"][data-tool-status]') ?? root.querySelector("[data-tool-status]");
  const tiles = [...root.querySelectorAll("[data-tile]")].filter((tile) => tile.checkVisibility({ checkVisibilityCSS: true }));
  return {
    tag: root.tagName.toLowerCase(),
    open: details ? root.open : null,
    status: status?.getAttribute("data-tool-status") ?? "",
    role: status?.getAttribute("role") ?? "",
    text: clean(status?.textContent),
    detail: root.querySelector("[data-tool-detail]") ? clean(root.querySelector("[data-tool-detail]").textContent) : null,
    tiles: tiles.map((tile) => ({
      inSummary: summary !== null && summary.contains(tile),
      hidden: tile.closest('[aria-hidden="true"]') !== null,
      background: getComputedStyle(tile).backgroundColor,
    })),
    height: Math.round((summary ?? root).getBoundingClientRect().height),
    coarse: matchMedia("(pointer: coarse)").matches,
    rootText: clean(root.innerText).slice(0, 120),
  };
}

const describe = (line) => `${line.tag}${line.open ? "[open]" : ""} status=${line.status}${line.role ? "" : " (no role=status)"} text=${JSON.stringify(line.text)} shows ${JSON.stringify(line.rootText)}`;
const state = ({ tag, open, status, text, detail }) => JSON.stringify({ tag, open, status, text, detail });

// A finished tool call is a closed <details> line, and its results show once the summary is clicked or tapped.
async function openLine(line, tap = false) {
  if (!(await line.evaluate((root) => root.matches("details:not([open])")))) return;
  const summary = line.locator(":scope > summary");
  await (tap ? summary.tap() : summary.click());
  await eventually(() => line.evaluate((root) => root.open), Boolean, { timeoutMs: 2_000, what: "the tool line to open" });
  // The caret turns on open. Let that transition end so a screenshot shows the open state, not its first frame.
  await line.evaluate((root) => Promise.all(root.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished)));
}

async function links(line) {
  return line.getByRole("link").evaluateAll((anchors) => anchors.map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
}

// Visible text that is exactly a tool's code name, anywhere on the page.
function rawNames(names) {
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (names.includes(text) && node.parentElement?.checkVisibility({ checkVisibilityCSS: true })) found.push(text);
  }
  return found;
}

function pageWidth() {
  return { scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, width: document.documentElement.clientWidth };
}

export default async function toolCards({ page, origin, mockUrl, step, shot }) {
  const browser = page.context().browser();
  const cookies = await page.context().cookies();
  const contexts = [];
  let searxng = await startMockSearxng();
  const listMemories = async () => (await (await page.request.get(`${origin}/api/memories?q=${encodeURIComponent("Fly.io")}`)).json()).memories ?? [];
  const before = new Set((await listMemories()).map((memory) => memory.id));

  try {
    const saved = await page.request.put(`${origin}/api/settings`, { data: {
      baseUrl: mockUrl, model: "mock-genui", reasoningEffort: "low", searxngUrl: searxng.url, tavilyApiKey: null,
    } });
    step("search settings point at the SearXNG fixture", saved.status() === 200, `status ${saved.status()}`);

    await page.setViewportSize({ width: 1440, height: 900 });
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    const chatUrl = `${origin}/c/${id}`;
    await page.goto(chatUrl);
    const composer = page.getByPlaceholder("Ask anything");
    await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the composer to accept input" });
    const reply = () => page.locator('[data-message-role="assistant"]').last();
    const send = async (text) => {
      await composer.fill(text);
      await composer.press("Enter");
    };
    const searches = page.locator('[data-tool-name="web_search"]');
    const lines = page.locator("[data-tool-name]");

    // 1. A search runs, finishes, and settles into a closed line with colored tiles.
    await send("[qa:search] orbit");
    const search = searches.nth(0);
    await search.locator('[data-tool-status="running"]').waitFor({ timeout: 15_000 });
    const running = await search.evaluate(readLine);
    step("a running search line reads Searching the web", running.text === "Searching the web" && running.status === "running" && running.role === "status", describe(running));
    await shot("search-running-1440");
    await search.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 20_000 });
    await reply().getByRole("link", { name: "Orbit guide", exact: true }).last().waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });
    const done = await search.evaluate(readLine);
    step("a finished search line reads Searched the web, 3 sources", done.text === "Searched the web, 3 sources" && done.status === "succeeded" && done.role === "status", describe(done));
    step("a finished search line starts closed", done.tag === "details" && done.open === false, describe(done));
    step("the search line shows three tiles in its summary, hidden from screen readers", done.tiles.length === 3 && done.tiles.every((tile) => tile.inSummary && tile.hidden), JSON.stringify(done.tiles));
    step("at least two search tiles have different colors", new Set(done.tiles.map((tile) => tile.background)).size >= 2, JSON.stringify(done.tiles.map((tile) => tile.background)));
    await shot("search-closed-1440");
    await openLine(search);
    const opened = await links(search);
    step("opening the search line shows three links that open safely", opened.length === 3 && opened.every((link) => link.target === "_blank" && link.rel === SAFE_REL), JSON.stringify(opened));
    await shot("search-open-1440");
    if (await search.evaluate((root) => root.matches("details[open]"))) await search.locator(":scope > summary").click();

    // 2. A memory save is one line with the saved text and no raw tool name.
    await send(`[qa:remember] ${MEMORY}`);
    const memory = page.locator('[data-tool-name="remember"]').last();
    await reply().getByText("Saved.", { exact: true }).waitFor({ timeout: 30_000 });
    await memory.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });
    const remembered = await memory.evaluate(readLine);
    step("a saved memory line reads Saved to memory", remembered.text === "Saved to memory" && remembered.status === "succeeded" && remembered.role === "status", describe(remembered));
    step("the memory line shows the saved text", remembered.detail === MEMORY, `[data-tool-detail] ${JSON.stringify(remembered.detail)}; ${describe(remembered)}`);
    const raw = await page.evaluate(rawNames, [...RAW_NAMES]);
    step("no visible text is a raw tool name", raw.length === 0, `found ${JSON.stringify(raw)}`);
    await memory.scrollIntoViewIfNeeded();
    await shot("remember-1440");

    // 3. With SearXNG gone, the search fails and its line starts open.
    await searxng.close();
    searxng = null;
    await send("[qa:search] orbit");
    const failed = searches.nth(1);
    await failed.locator('[data-tool-status="failed"]').waitFor({ timeout: 20_000 });
    await reply().getByText("Search is unavailable.", { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });
    const broken = await failed.evaluate(readLine);
    step("a failed search line reads Search failed", broken.text === "Search failed" && broken.status === "failed" && broken.role === "status", describe(broken));
    step("a failed search line starts open", broken.tag === "details" && broken.open === true, describe(broken));
    await failed.scrollIntoViewIfNeeded();
    await shot("search-failed-1440");

    // 4. A reload keeps each line's words, status, and open or closed state.
    const kept = await lines.evaluateAll((roots, source) => roots.map((root) => new Function(`return (${source})`)()(root)), readLine.toString());
    await page.reload();
    await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the reloaded chat to hydrate" });
    await failed.locator('[data-tool-status="failed"]').waitFor({ timeout: 15_000 });
    const back = await lines.evaluateAll((roots, source) => roots.map((root) => new Function(`return (${source})`)()(root)), readLine.toString());
    step("the chat reloads with three tool lines", kept.length === 3 && back.length === 3, `${kept.length} before, ${back.length} after`);
    for (const [index, name] of ["the finished search", "the memory", "the failed search"].entries()) {
      step(`after reload ${name} line keeps its words, status, and open state`, back[index] !== undefined && state(back[index]) === state(kept[index]), `before ${kept[index] ? state(kept[index]) : "none"}, after ${back[index] ? state(back[index]) : "none"}`);
    }
    await shot("reloaded-1440");

    // 5. Touch views: a tap opens the line, every line takes a 44px tap, and the page never scrolls sideways.
    for (const view of [{ name: "390", width: 390, height: 844 }, { name: "360", width: 360, height: 780 }]) {
      const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      contexts.push(context);
      await context.addCookies(cookies);
      const phone = await context.newPage();
      await phone.goto(chatUrl);
      await eventually(() => phone.getByPlaceholder("Ask anything").isEnabled(), Boolean, { timeoutMs: 15_000, what: `the chat to hydrate at ${view.name}` });
      const phoneSearch = phone.locator('[data-tool-name="web_search"]').first();
      await phoneSearch.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 15_000 });
      const all = await phone.locator("[data-tool-name]").evaluateAll((roots, source) => roots.map((root) => new Function(`return (${source})`)()(root)), readLine.toString());
      step(`${view.name} touch: every tool line is at least 44px tall`, all.length === 3 && all.every((line) => line.height >= 44), `${all.map((line) => `${line.tag} ${line.height}px`).join(", ")}; pointer coarse ${all[0]?.coarse}`);
      const first = all[0];
      step(`${view.name} touch: the search line shows three tiles`, first !== undefined && first.tiles.length === 3, JSON.stringify(first?.tiles ?? []));
      step(`${view.name} touch: the page does not scroll sideways`, (await phone.evaluate(pageWidth)).scrollWidth <= view.width, JSON.stringify(await phone.evaluate(pageWidth)));
      await phoneSearch.scrollIntoViewIfNeeded();
      await shot(`search-closed-${view.name}`, phone);
      await openLine(phoneSearch, true);
      const tapped = await links(phoneSearch);
      step(`${view.name} touch: a tap opens the search line to three safe links`, tapped.length === 3 && tapped.every((link) => link.target === "_blank" && link.rel === SAFE_REL), JSON.stringify(tapped));
      step(`${view.name} touch: the open search line does not scroll the page sideways`, (await phone.evaluate(pageWidth)).scrollWidth <= view.width, JSON.stringify(await phone.evaluate(pageWidth)));
      await shot(`search-open-${view.name}`, phone);
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (searxng) await searxng.close();
    await page.request.put(`${origin}/api/settings`, { data: {
      baseUrl: mockUrl, model: "mock-genui", reasoningEffort: "low", searxngUrl: "", tavilyApiKey: null,
    } });
    // Delete only the memory this run saved, so later scenarios on this server never recall it.
    for (const saved of (await listMemories()).filter((memory) => memory.text === MEMORY && !before.has(memory.id))) {
      await page.request.delete(`${origin}/api/memories/${saved.id}`);
    }
  }
}
