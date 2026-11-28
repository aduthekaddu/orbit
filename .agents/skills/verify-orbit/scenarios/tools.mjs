import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { startMockMcp } from "../../../../scripts/qa/mock-mcp.mjs";
import { startMockSearxng } from "../../../../scripts/qa/mock-searxng.mjs";
import { githubSave, searchSave } from "../../../../scripts/qa/settings-save.mjs";
import { eventually } from "../../../../src/lib/eventually.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const verifyDir = path.join(repoRoot, ".verify");
const requestLog = path.join(verifyDir, "mock-requests.jsonl");
const serverState = path.join(verifyDir, "server.json");
const proofFile = path.join(verifyDir, "evidence", "tools", "provider-requests.jsonl");

const TOOL_IDS = ["web_search", "run_code", "github", "memory", "render_ui"];
const STATUS_WORDS = ["Working", "Failing", "Not tested", "Off", "On"];
const TAVILY_KEY = "test-tavily-key-not-real";
const PROVIDER_KEY = "test-key-not-real";
const CLOSED_URL = "http://127.0.0.1:9";
const SEARCH_INSTRUCTION = "Use web_search for recent events, prices, or facts you are unsure of. Cite sources as markdown links to result URLs.";
const REMEMBER_INSTRUCTIONS = "Call remember only when";
const SAVED_NOTES = "Saved notes follow";
const TITLE_PROMPT = "Write a title of at most six words.";
const TEA = "I prefer green tea";
const TEA_QUESTION = "[qa:tools] What tea do I prefer?";
const HI = "[qa:tools] hi";
const RATE_LIMITED = "Wait a moment before testing again.";
const SAVE_FAILED = "Could not save tools.";

const pathOf = (response) => new URL(response.url()).pathname;
const logSize = () => (fs.existsSync(requestLog) ? fs.readFileSync(requestLog, "utf8").length : 0);

// The first streamed provider request after `offset` whose last message holds `prompt`. A title request does not stream.
function providerRequest(prompt, offset) {
  const text = fs.existsSync(requestLog) ? fs.readFileSync(requestLog, "utf8").slice(offset) : "";
  const entry = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) =>
    line.body?.stream === true && !JSON.stringify(line.body).includes(TITLE_PROMPT) && JSON.stringify(line.body.messages?.at(-1) ?? null).includes(prompt),
  );
  if (!entry) return null;
  const body = JSON.stringify(entry.body);
  const tools = (entry.body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean).sort();
  return {
    prompt,
    tools,
    savedNotes: body.includes(SAVED_NOTES),
    rememberInstructions: body.includes(REMEMBER_INSTRUCTIONS),
    parameters: (name) => entry.body.tools?.find((tool) => tool.function?.name === name)?.function?.parameters ?? null,
  };
}

const replyTools = (text) => (/tools: ([^\n]*)/.exec(text)?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean).sort();

export default async function tools({ page, origin, step, shot, useProvider, seedMember, signInMember }) {
  const browser = page.context().browser();
  const request = page.request;
  const adminSettings = `${origin}/api/admin/settings`;
  const searxng = await startMockSearxng();
  const mcp = await startMockMcp();
  const contexts = [];
  const chats = [];
  const evidence = [];
  const adminBodies = [];
  const memberBodies = [];
  const testRequests = [];
  const chatPatches = [];
  const changed = { search: false, tavily: false, github: false, memory: false, mode: false, tea: false };
  let memberEmail = null;

  const readJson = async (url, actor = request) => {
    const response = await actor.get(url);
    assert.equal(response.status(), 200, `read ${new URL(url).pathname}`);
    return response.json();
  };
  let original = null;
  const sandboxOn = JSON.parse(fs.readFileSync(serverState, "utf8")).sandboxEnabled === true;

  const watch = (target, bodies) => {
    target.on("response", (response) => {
      if (pathOf(response).startsWith("/api/tools")) bodies.push(response.text().catch(() => ""));
    });
  };
  watch(page, adminBodies);
  page.on("request", (sent) => {
    const pathname = new URL(sent.url()).pathname;
    if (sent.method() === "POST" && /^\/api\/tools\/[^/]+\/test$/.test(pathname)) testRequests.push(pathname);
    if (sent.method() === "PATCH" && /^\/api\/chats\/[^/]+$/.test(pathname)) chatPatches.push(pathname);
  });

  const secrets = () => [
    { name: "GitHub token", found: (text) => text.includes(mcp.token) },
    { name: "Tavily key", found: (text) => text.includes(TAVILY_KEY) },
    { name: "provider key", found: (text) => text.includes(PROVIDER_KEY) },
    { name: "SearXNG URL", found: (text) => text.includes(searxng.url) },
    { name: "closed SearXNG URL", found: (text) => /http:\/\/127\.0\.0\.1:9(?!\d)/.test(text) },
  ];
  const leaks = async (bodies) => {
    const texts = await Promise.all(bodies);
    return secrets().filter(({ found }) => texts.some(found)).map(({ name }) => name);
  };

  // --- Tools page -------------------------------------------------------------------------------

  const row = (target, id) => target.locator(`[data-tool-row="${id}"]`);
  const expander = (target, id) => row(target, id).locator("button[aria-controls]").first();
  const testButton = (target, id) => row(target, id).getByRole("button", { name: /^Test(ing)?$/ });
  const setUp = (target, id) => row(target, id).getByRole("link", { name: "Set up", exact: true });
  const region = (target, id) => row(target, id).getByRole("region");
  // The caret turns over 200ms. A shot taken sooner shows it half turned.
  const settled = (target, id) => row(target, id).evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished)));

  // React marks the nodes it hydrated. A click before hydration does nothing.
  const hydrated = (locator, what) =>
    eventually(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))).catch(() => false), Boolean, {
      timeoutMs: 15_000,
      what,
    });

  async function openTools(target = page) {
    const response = await target.goto(`${origin}/tools`);
    await hydrated(expander(target, "web_search"), "the tools page to hydrate");
    return response;
  }

  async function statusOf(target, id) {
    const text = await expander(target, id).innerText();
    const words = STATUS_WORDS.filter((word) => new RegExp(`(^|\\s)${word}(\\s|$)`).test(text));
    return words.length === 1 ? words[0] : `${words.join("|") || "none"} in ${JSON.stringify(text)}`;
  }

  const statusBecomes = (target, id, word, timeoutMs = 10_000) =>
    eventually(() => statusOf(target, id), (status) => status === word, { timeoutMs, what: `${id} to show ${word}` }).catch(() => statusOf(target, id));

  async function rowState(target, id) {
    const link = setUp(target, id);
    return {
      status: await statusOf(target, id),
      test: await testButton(target, id).count(),
      setUp: (await link.count()) ? await link.getAttribute("href") : null,
    };
  }

  async function pressTest(target, id) {
    const answered = target.waitForResponse((response) => pathOf(response) === `/api/tools/${id}/test` && response.request().method() === "POST", { timeout: 30_000 });
    await testButton(target, id).click();
    const response = await answered;
    await eventually(() => testButton(target, id).innerText(), (label) => label === "Test", { timeoutMs: 5_000, what: `${id} Test to finish` }).catch(() => {});
    return response;
  }

  const lineOf = async (target, id, role) => {
    const line = row(target, id).getByRole(role).first();
    return (await line.waitFor({ timeout: 5_000 }).then(() => true, () => false)) ? (await line.innerText()).trim() : "";
  };

  async function apiTool(id, actor = request) {
    const { tools: views } = await readJson(`${origin}/api/tools`, actor);
    return views.find((view) => view.id === id);
  }

  async function saveSearch(url, tavilyKey) {
    await page.goto(`${origin}/admin`);
    const field = page.getByLabel("SearXNG URL", { exact: true });
    await hydrated(field, "the admin page to hydrate");
    await field.fill(url);
    if (tavilyKey) await page.getByLabel("Tavily key", { exact: true }).fill(tavilyKey);
    const saved = page.waitForResponse((response) => pathOf(response) === "/api/admin/settings" && response.request().method() === "PUT");
    await searchSave(page).click();
    assert.equal((await saved).status(), 200, `save the SearXNG URL ${url}`);
    changed.search = true;
    if (tavilyKey) changed.tavily = true;
  }

  // --- Chats --------------------------------------------------------------------------------------

  const composer = (target) => target.getByPlaceholder("Ask anything", { exact: true });
  const composerReady = (target = page) =>
    eventually(() => composer(target).isEnabled(), Boolean, { timeoutMs: 15_000, what: "the chat to hydrate" });
  const trigger = (target) => target.locator("[data-tools-trigger]").first();
  const popover = (target) => target.locator('[data-tools-sheet="popover"]');

  async function newChat(target = page) {
    const created = await target.request.post(`${origin}/api/chats`);
    assert.equal(created.status(), 201, "create a chat");
    const { id } = await created.json();
    chats.push(id);
    await target.goto(`${origin}/c/${id}`);
    await composerReady(target);
    return id;
  }

  async function send(target, prompt, reply) {
    const replies = target.locator('[data-message-role="assistant"]');
    const before = await replies.count();
    await composer(target).fill(prompt);
    await composer(target).press("Enter");
    await replies.nth(before).getByText(reply).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await target.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 30_000 });
    return replies.nth(before).innerText();
  }

  async function sentTurn(prompt, offset) {
    return eventually(() => providerRequest(prompt, offset), Boolean, { timeoutMs: 10_000, what: `the provider request for ${prompt}` });
  }

  async function openToolsPopover(target = page) {
    await trigger(target).click();
    await popover(target).waitFor();
    return popover(target);
  }

  const switchStates = (container) =>
    container.getByRole("switch").evaluateAll((elements) =>
      elements.map((element) => ({ name: element.labels?.[0]?.textContent?.trim() ?? "", on: element.getAttribute("aria-checked") === "true", disabled: element.disabled })),
    );
  const toolSwitch = (container, name) => container.getByRole("switch", { name, exact: true });

  // The dot is the one aria-hidden mark on the trigger painted with --sun.
  const sunDot = (target) =>
    trigger(target).evaluate((button) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--sun)";
      document.body.append(probe);
      const sun = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [...button.querySelectorAll("[aria-hidden]")].some((element) => element.tagName.toLowerCase() !== "svg" && getComputedStyle(element).backgroundColor === sun && element.getBoundingClientRect().width > 0);
    });

  async function chatOrder() {
    const { chats: listed } = await readJson(`${origin}/api/chats`);
    return listed.map(({ id, updatedAt }) => ({ id, updatedAt }));
  }

  const sidebarOrder = () => page.locator('nav a[href^="/c/"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")));

  const focused = (target) =>
    target.evaluate(() => {
      const element = document.activeElement;
      return {
        row: element?.closest("[data-tool-row]")?.getAttribute("data-tool-row") ?? null,
        expands: Boolean(element?.hasAttribute("aria-controls")),
        expanded: element?.getAttribute("aria-expanded") ?? null,
        text: element?.textContent?.trim().slice(0, 40) ?? "",
        role: element?.getAttribute("role") ?? null,
        toolsTrigger: Boolean(element?.hasAttribute("data-tools-trigger")),
        modelChip: Boolean(element?.hasAttribute("data-model-chip")),
        inPopover: Boolean(element?.closest("[data-tools-sheet]")),
      };
    });

  // A keyboard user's first Tab lands on the skip link, and Enter moves focus to <main>, past the sidebar's chats.
  async function skipToContent(target) {
    await target.keyboard.press("Tab");
    const link = (await focused(target)).text;
    if (!/^Skip to (content|chat)$/.test(link)) return { link, inMain: false };
    await target.keyboard.press("Enter");
    return { link, inMain: await target.evaluate(() => document.activeElement?.id === "content") };
  }

  async function tabUntil(target, matches, limit = 80) {
    for (let count = 0; count < limit; count += 1) {
      await target.keyboard.press("Tab");
      if (matches(await focused(target))) return true;
    }
    return false;
  }

  try {
    original = {
      admin: await (await request.get(adminSettings)).json(),
      github: await (await request.get(`${origin}/api/settings`)).json(),
      preferences: await (await request.get(`${origin}/api/preferences`)).json(),
    };

    // --- The page exists --------------------------------------------------------------------------
    const first = await page.goto(`${origin}/tools`);
    const rowCount = await page.locator("[data-tool-row]").count();
    if (!step("GET /tools returns 200 with 5 tool rows", first?.status() === 200 && rowCount === 5, `status ${first?.status()}, rows ${rowCount}`)) {
      await shot("missing");
      return;
    }

    assert.equal(original.admin.tavilyKeySet, false, "use a sandbox without a saved Tavily key");
    assert.equal(original.github.githubTokenSet, false, "use a sandbox without a saved GitHub token");
    await useProvider();
    if (original.admin.searxngUrl !== "") {
      assert.equal((await request.put(adminSettings, { data: { searxngUrl: "" } })).status(), 200, "start with search off");
      changed.search = true;
    }
    if (original.preferences.memory !== "on") {
      assert.equal((await request.patch(`${origin}/api/preferences`, { data: { memory: "on" } })).status(), 200, "start with Memory on");
      changed.memory = true;
    }

    // --- Initial states (1280x800) ---------------------------------------------------------------
    await page.setViewportSize({ width: 1280, height: 800 });
    await openTools();
    const api = await readJson(`${origin}/api/tools`);
    step("GET /api/tools returns the five tools in order", isDeepStrictEqual(api.tools.map((view) => view.id), TOOL_IDS), JSON.stringify(api.tools.map((view) => view.id)));
    const start = Object.fromEntries(await Promise.all(TOOL_IDS.map(async (id) => [id, await rowState(page, id)])));
    step("Web search shows Off with Set up to /admin#search", isDeepStrictEqual(start.web_search, { status: "Off", test: 0, setUp: "/admin#search" }), JSON.stringify(start.web_search));
    step(
      sandboxOn ? "Code sandbox shows Not tested with Test while ORBIT_SANDBOX is on" : "Code sandbox shows Off with no Set up while ORBIT_SANDBOX is unset",
      isDeepStrictEqual(start.run_code, sandboxOn ? { status: "Not tested", test: 1, setUp: null } : { status: "Off", test: 0, setUp: null }),
      JSON.stringify(start.run_code),
    );
    step("GitHub shows Off with Set up to /settings#github", isDeepStrictEqual(start.github, { status: "Off", test: 0, setUp: "/settings#github" }), JSON.stringify(start.github));
    // Memory health survives earlier scenarios' remember calls, since no setting change clears it.
    step("Memory shows Test and no Set up", start.memory.test === 1 && start.memory.setUp === null && ["Not tested", "Working"].includes(start.memory.status), JSON.stringify(start.memory));
    step("Generated UI shows On with no Test", isDeepStrictEqual(start.render_ui, { status: "On", test: 0, setUp: null }), JSON.stringify(start.render_ui));
    await shot("page");

    const sidebarLink = page.getByRole("link", { name: "Tools", exact: true }).first();
    const sidebarHref = (await sidebarLink.count()) ? await sidebarLink.getAttribute("href") : null;
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.waitFor();
    const paletteTools = await palette.getByRole("option", { name: "Tools", exact: true }).count();
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    step("the sidebar links to /tools and the palette has a Tools command", sidebarHref === "/tools" && paletteTools === 1, `href ${sidebarHref}, palette ${paletteTools}`);

    await setUp(page, "web_search").click();
    await page.waitForURL((url) => url.pathname === "/admin" && url.hash === "#search");
    const searchCard = await page.locator("#search").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await openTools();
    await setUp(page, "github").click();
    await page.waitForURL((url) => url.pathname === "/settings" && url.hash === "#github");
    const githubCard = await page.locator("#github").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    step("Set up lands on the Search card on /admin and the GitHub card on /settings", searchCard && githubCard, `#search ${searchCard}, #github ${githubCard}`);

    if (sandboxOn) {
      await openTools();
      const ran = await pressTest(page, "run_code");
      const summary = await lineOf(page, "run_code", "status");
      step("Test on Code sandbox shows Working and Exit 0", ran.status() === 200 && (await statusOf(page, "run_code")) === "Working" && /^Exit 0 · /.test(summary), `status ${ran.status()}, line ${summary}`);
      await shot("sandbox-ok");
    }

    // --- Live tests -------------------------------------------------------------------------------
    await saveSearch(searxng.url, TAVILY_KEY);
    await openTools();
    step("saving a SearXNG URL makes Web search Not tested with Test", isDeepStrictEqual(await rowState(page, "web_search"), { status: "Not tested", test: 1, setUp: null }));
    const searched = await pressTest(page, "web_search");
    const searchLine = await lineOf(page, "web_search", "status");
    const searchStatus = await statusBecomes(page, "web_search", "Working");
    const when = row(page, "web_search").locator("time");
    const whenText = (await when.waitFor({ timeout: 5_000 }).then(() => true, () => false)) ? (await when.innerText()).trim() : "";
    step(
      "Test on Web search shows Working, 3 results, and now",
      searched.status() === 200 && searchStatus === "Working" && /^3 results · \d+(\.\d)? (ms|s)$/.test(searchLine) && whenText === "now",
      `status ${searched.status()}, row ${searchStatus}, line ${JSON.stringify(searchLine)}, time ${JSON.stringify(whenText)}`,
    );

    const again = await pressTest(page, "web_search");
    const retryAfter = Number(again.headers()["retry-after"]);
    const windowEnds = Date.now() + Math.max(retryAfter || 10, 1) * 1_000 + 250;
    const limited = await lineOf(page, "web_search", "alert");
    step(
      "a second Test right away gets 429 and shows the wait message while Web search stays Working",
      again.status() === 429 && retryAfter >= 1 && limited === RATE_LIMITED && (await statusOf(page, "web_search")) === "Working",
      `status ${again.status()}, Retry-After ${retryAfter}, alert ${JSON.stringify(limited)}`,
    );

    await page.goto(`${origin}/settings`);
    const tokenField = page.getByLabel("Token", { exact: true });
    await hydrated(tokenField, "the settings page to hydrate");
    await tokenField.fill(mcp.token);
    await page.getByLabel("MCP URL", { exact: true }).fill(mcp.url);
    const githubSaved = page.waitForResponse((response) => pathOf(response) === "/api/settings" && response.request().method() === "PUT");
    await githubSave(page).click();
    const github = await githubSaved;
    changed.github = github.ok();
    assert.equal(github.status(), 200, "save the mock GitHub token on /settings");
    await openTools();
    const githubStart = await rowState(page, "github");
    const checked = await pressTest(page, "github");
    const githubLine = await lineOf(page, "github", "status");
    const githubStatus = await statusBecomes(page, "github", "Working");
    step(
      "Test on GitHub shows Working and octocat",
      githubStart.status === "Not tested" && checked.status() === 200 && githubStatus === "Working" && /^octocat · /.test(githubLine),
      `before ${JSON.stringify(githubStart)}, status ${checked.status()}, row ${githubStatus}, line ${JSON.stringify(githubLine)}`,
    );
    await eventually(() => mcp.openSessions(), (open) => open === 0, { timeoutMs: 5_000, what: "the GitHub test to close its MCP session" }).catch(() => {});
    step("the GitHub test closes its MCP session", mcp.openSessions() === 0, `${mcp.openSessions()} open`);

    const { memories } = await readJson(`${origin}/api/memories`);
    const remembered = await pressTest(page, "memory");
    const memoryLine = await lineOf(page, "memory", "status");
    const memoryStatus = await statusBecomes(page, "memory", "Working");
    const count = /^(\d+) (memory|memories)( · Text search only)? · /.exec(memoryLine);
    step(
      "Test on Memory shows Working and the saved memory count",
      remembered.status() === 200 && memoryStatus === "Working" && Number(count?.[1]) === memories.length && count?.[2] === (memories.length === 1 ? "memory" : "memories"),
      `status ${remembered.status()}, row ${memoryStatus}, line ${JSON.stringify(memoryLine)}, saved ${memories.length}`,
    );

    // --- Failure without secrets -------------------------------------------------------------------
    // A closed SearXNG falls back to Tavily, so the key goes first to keep the check off the network.
    assert.equal((await request.put(adminSettings, { data: { tavilyApiKey: null } })).status(), 200, "remove the Tavily key");
    changed.tavily = false;
    await saveSearch(CLOSED_URL);
    await openTools();
    step("saving a new SearXNG URL resets Web search to Not tested", (await statusOf(page, "web_search")) === "Not tested");
    // The rate limit allows one Test start per tool every 10 seconds. Retry-After said when this window ends.
    await eventually(() => Date.now(), (now) => now >= windowEnds, { timeoutMs: 15_000, intervalMs: 250, what: "the Web search Test window to pass" });
    const broken = await pressTest(page, "web_search");
    const brokenBody = await broken.json().catch(() => null);
    const brokenStatus = await statusBecomes(page, "web_search", "Failing");
    const brokenAlert = await lineOf(page, "web_search", "alert");
    step(
      "Test against a closed SearXNG shows Failing with Search is unavailable",
      broken.status() === 200 && brokenBody?.ok === false && brokenStatus === "Failing" && brokenAlert === "Search is unavailable",
      `status ${broken.status()}, ok ${brokenBody?.ok}, row ${brokenStatus}, alert ${JSON.stringify(brokenAlert)}`,
    );
    await shot("failing");
    const adminLeaks = await leaks(adminBodies);
    step("no /api/tools response holds the Tavily key, the GitHub token, the provider key, or a SearXNG URL", adminLeaks.length === 0 && adminBodies.length > 0, `${adminBodies.length} bodies, found ${adminLeaks.join(", ") || "none"}`);

    // --- Schema parity -------------------------------------------------------------------------------
    await saveSearch(searxng.url);
    await openTools();
    await expander(page, "web_search").click();
    const webRegion = region(page, "web_search");
    await webRegion.getByText("web_search", { exact: true }).first().waitFor({ timeout: 15_000 });
    const inspected = await readJson(`${origin}/api/tools/web_search`);
    const description = inspected.tools?.[0]?.description ?? "";
    const rendered = JSON.parse(await webRegion.locator("pre").first().innerText());
    const shows = {
      expanded: (await expander(page, "web_search").getAttribute("aria-expanded")) === "true",
      description: description !== "" && (await webRegion.getByText(description, { exact: true }).count()) > 0,
      heading: (await webRegion.getByText("System instruction", { exact: true }).count()) === 1,
      instruction: (await webRegion.getByText(SEARCH_INSTRUCTION, { exact: true }).count()) === 1,
      schema: isDeepStrictEqual(rendered, inspected.tools?.[0]?.inputSchema),
    };
    step("expanding Web search shows web_search, its description, its JSON Schema, and the search instruction", Object.values(shows).every(Boolean), JSON.stringify(shows));
    await settled(page, "web_search");
    await shot("expanded");

    await newChat();
    let offset = logSize();
    await send(page, HI, /^tools:/);
    const parity = await sentTurn(HI, offset);
    const wire = parity.parameters("web_search");
    evidence.push({ check: "schema parity", prompt: HI, tools: parity.tools, rendered, wire });
    step("the schema on /tools deep-equals the web_search parameters sent to the provider", wire !== null && isDeepStrictEqual(rendered, wire), JSON.stringify({ rendered, wire }));

    await openTools();
    await expander(page, "github").click();
    const githubRegion = region(page, "github");
    const listed = await githubRegion.getByText(/^github_\w+$/).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const githubNames = listed ? await githubRegion.getByText(/^github_\w+$/).allInnerTexts() : [];
    await eventually(() => mcp.openSessions(), (open) => open === 0, { timeoutMs: 5_000, what: "the GitHub inspection to close its MCP session" }).catch(() => {});
    step("expanding GitHub lists github_* tools and closes the MCP session", githubNames.length > 0 && mcp.openSessions() === 0, `${githubNames.join(", ")}; ${mcp.openSessions()} open`);

    // --- Memory with the tool on ------------------------------------------------------------------
    const memoryChat = await newChat();
    await send(page, `[qa:remember] ${TEA}`, "Saved.");
    changed.tea = true;
    offset = logSize();
    const recalledReply = await send(page, TEA_QUESTION, /^tools:/);
    const recalled = await sentTurn(TEA_QUESTION, offset);
    evidence.push({ check: "memory on", ...recalled, reply: replyTools(recalledReply) });
    step(
      "with Memory on, the tea question carries the saved note, the memory instruction, and remember and forget",
      recalled.savedNotes && recalled.rememberInstructions && recalled.tools.includes("remember") && recalled.tools.includes("forget"),
      JSON.stringify(recalled),
    );

    // --- Draft toggles -------------------------------------------------------------------------------
    const expectedSwitches = ["Web search", ...(sandboxOn ? ["Code sandbox"] : []), "GitHub", "Memory"];
    await page.goto(`${origin}/new`);
    await page.waitForURL((url) => url.pathname.startsWith("/c/") && url.searchParams.has("new"));
    const draftId = new URL(page.url()).pathname.split("/").pop();
    await composerReady();
    const patchesBefore = chatPatches.length;
    let tray = await openToolsPopover();
    const draftSwitches = await switchStates(tray);
    step(
      "the + popover has one switch per ready tool, all on, and no Generated UI",
      isDeepStrictEqual(draftSwitches.map(({ name }) => name), expectedSwitches) && draftSwitches.every(({ on, disabled }) => on && !disabled),
      JSON.stringify(draftSwitches),
    );
    await toolSwitch(tray, "Web search").click();
    const draftOff = (await toolSwitch(tray, "Web search").getAttribute("aria-checked")) === "false";
    const draftLabel = await trigger(page).getAttribute("aria-label");
    const draftDot = await sunDot(page);
    step(
      "turning Web search off in a draft sends no PATCH and marks + with the sun dot",
      draftOff && chatPatches.length === patchesBefore && draftLabel === "Tools (1 off)" && draftDot,
      `off ${draftOff}, PATCHes ${chatPatches.length - patchesBefore}, label ${draftLabel}, dot ${draftDot}`,
    );
    // The switch slides for 150ms after a click; shoot its settled state.
    await tray.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished)));
    await shot("popover");
    await page.keyboard.press("Escape");
    await tray.waitFor({ state: "hidden" });
    offset = logSize();
    const draftReply = await send(page, HI, /^tools:/);
    chats.push(draftId);
    const draftTurn = await sentTurn(HI, offset);
    evidence.push({ check: "draft with web_search off", ...draftTurn, reply: replyTools(draftReply) });
    step(
      "the draft's first reply omits web_search and keeps render_ui",
      !draftTurn.tools.includes("web_search") && draftTurn.tools.includes("render_ui") && !replyTools(draftReply).includes("web_search") && replyTools(draftReply).length > 0,
      `request ${draftTurn.tools.join(", ")}; reply ${replyTools(draftReply).join(", ")}`,
    );
    step("the first send saved the draft's switches without a PATCH", chatPatches.length === patchesBefore, `${chatPatches.length - patchesBefore} PATCHes`);
    await page.reload();
    await composerReady();
    tray = await openToolsPopover();
    const reloaded = (await toolSwitch(tray, "Web search").getAttribute("aria-checked")) === "false";
    step("Web search stays off in that chat after reload", reloaded && new URL(page.url()).pathname === `/c/${draftId}`, page.url());
    await page.keyboard.press("Escape");

    await page.goto(`${origin}/new`);
    await page.waitForURL((url) => url.searchParams.has("new"));
    await composerReady();
    tray = await openToolsPopover();
    const fresh = (await toolSwitch(tray, "Web search").getAttribute("aria-checked")) === "true";
    const freshLabel = await trigger(page).getAttribute("aria-label");
    step("a second new chat starts with Web search on", fresh && freshLabel === "Tools", `on ${fresh}, label ${freshLabel}`);
    await page.keyboard.press("Escape");

    // --- Saved chat: Memory off ---------------------------------------------------------------------
    await page.goto(`${origin}/c/${memoryChat}`);
    await composerReady();
    const orderBefore = await chatOrder();
    const sidebarBefore = await sidebarOrder();
    tray = await openToolsPopover();
    const savedMemory = page.waitForResponse((response) => pathOf(response) === `/api/chats/${memoryChat}` && response.request().method() === "PATCH");
    await toolSwitch(tray, "Memory").click();
    const memoryPatch = await savedMemory;
    const memoryBody = memoryPatch.request().postDataJSON();
    const orderAfter = await chatOrder();
    const sidebarAfter = await sidebarOrder();
    // A title can land on the newer draft chat meanwhile, so only the order and this chat's own time are compared.
    const ids = (order) => order.map(({ id }) => id);
    const memoryTime = (order) => order.find(({ id }) => id === memoryChat)?.updatedAt ?? null;
    step(
      "turning Memory off sends only that switch, saves with PATCH 200, and leaves the chat order, the sidebar order, and the chat's updatedAt unchanged",
      memoryPatch.status() === 200 && isDeepStrictEqual(memoryBody, { toolsOff: ["memory"], toolsOn: [] }) && orderBefore[0]?.id === draftId && isDeepStrictEqual(ids(orderBefore), ids(orderAfter)) && memoryTime(orderBefore) !== null && memoryTime(orderBefore) === memoryTime(orderAfter) &&
        sidebarBefore.length > 1 && isDeepStrictEqual(sidebarBefore, sidebarAfter),
      `status ${memoryPatch.status()}, body ${JSON.stringify(memoryBody)}, first ${orderBefore[0]?.id}, order kept ${isDeepStrictEqual(ids(orderBefore), ids(orderAfter))}, sidebar ${JSON.stringify(sidebarBefore)} -> ${JSON.stringify(sidebarAfter)}, updatedAt ${memoryTime(orderBefore)} -> ${memoryTime(orderAfter)}`,
    );
    await page.keyboard.press("Escape");
    offset = logSize();
    const forgotReply = await send(page, TEA_QUESTION, /^tools:/);
    const forgot = await sentTurn(TEA_QUESTION, offset);
    evidence.push({ check: "memory off", ...forgot, reply: replyTools(forgotReply) });
    step(
      "with Memory off, the reply omits remember and forget and the request has no saved notes or memory instruction",
      !forgot.tools.includes("remember") && !forgot.tools.includes("forget") && !forgot.savedNotes && !forgot.rememberInstructions && !replyTools(forgotReply).includes("remember"),
      JSON.stringify(forgot),
    );

    // --- A failed save rolls back -------------------------------------------------------------------
    const failPatch = (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal error" }) })
        : route.fallback();
    await page.route("**/api/chats/*", failPatch);
    try {
      tray = await openToolsPopover();
      const web = toolSwitch(tray, "Web search");
      const before = await web.getAttribute("aria-checked");
      await web.click();
      const alert = tray.getByRole("alert");
      const shown = await alert.waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const back = await eventually(() => web.getAttribute("aria-checked"), (value) => value === before, { timeoutMs: 5_000, what: "the switch to roll back" }).catch(() => "stuck");
      const alertText = shown ? (await alert.innerText()).trim() : "";
      step("a PATCH that fails with 500 puts the switch back and shows Could not save tools. in the popover", back === before && alertText === SAVE_FAILED, `before ${before}, after ${back}, alert ${JSON.stringify(alertText)}`);
      await shot("save-failed");
      await page.keyboard.press("Escape");
    } finally {
      await page.unroute("**/api/chats/*", failPatch);
    }
    const stored = await readJson(`${origin}/api/chats/${memoryChat}`);
    step("the failed save left the chat's stored tools as they were", isDeepStrictEqual(stored.disabledTools, ["memory"]), JSON.stringify(stored.disabledTools));

    // --- A save whose answer is lost ------------------------------------------------------------------
    const loseAnswer = async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fetch();
      return route.abort("failed");
    };
    await page.route("**/api/chats/*", loseAnswer);
    try {
      tray = await openToolsPopover();
      const web = toolSwitch(tray, "Web search");
      const reread = page.waitForResponse((response) => pathOf(response) === `/api/chats/${memoryChat}` && response.request().method() === "GET", { timeout: 10_000 }).then(() => true, () => false);
      await web.click();
      const readBack = await reread;
      const offAfter = await eventually(() => web.getAttribute("aria-checked"), (value) => value === "false", { timeoutMs: 5_000, what: "the switch to stay off" }).catch(() => "rolled back");
      const alertGone = await eventually(() => tray.getByRole("alert").count(), (count) => count === 0, { timeoutMs: 5_000, what: "the save error to clear" }).then(() => true, () => false);
      const kept = (await readJson(`${origin}/api/chats/${memoryChat}`)).disabledTools;
      step(
        "a PATCH that saved but lost its answer reads the chat back, keeps Web search off as saved, and shows no save error",
        readBack && offAfter === "false" && alertGone && isDeepStrictEqual(kept, ["memory", "web_search"]),
        `read ${readBack}, switch ${offAfter}, alert gone ${alertGone}, stored ${JSON.stringify(kept)}`,
      );
      await page.keyboard.press("Escape");
    } finally {
      await page.unroute("**/api/chats/*", loseAnswer);
    }
    assert.equal((await request.patch(`${origin}/api/chats/${memoryChat}`, { data: { toolsOn: ["web_search"] } })).status(), 200, "turn Web search back on");

    // --- A real chat call updates health --------------------------------------------------------------
    const resetSearch = await apiTool("web_search");
    const testsBefore = testRequests.length;
    await newChat();
    await send(page, "[qa:search] orbit", "Orbit guide");
    await page.locator('[data-tool-name="web_search"] [data-tool-status="succeeded"]').last().waitFor({ timeout: 30_000 });
    const recorded = await eventually(async () => (await apiTool("web_search")).status, (status) => status === "working", { timeoutMs: 5_000, what: "the chat call to mark Web search working" }).catch(() => "not working");
    await openTools();
    step(
      "a web_search call in chat turns Web search from Not tested to Working without Test",
      resetSearch.status === "untested" && recorded === "working" && (await statusOf(page, "web_search")) === "Working" && testRequests.length === testsBefore,
      `before ${resetSearch.status}, after ${recorded}, Test presses ${testRequests.length - testsBefore}`,
    );

    // --- Keyboard -------------------------------------------------------------------------------------
    // Each read below waits at most a few seconds, so a missed key fails this step instead of the scenario.
    const expanded = () => expander(page, "web_search").getAttribute("aria-expanded", { timeout: 5_000 }).catch(() => "missing");
    await openTools();
    const skip = await skipToContent(page);
    const reachedRow = skip.inMain && (await tabUntil(page, (focus) => focus.row === "web_search" && focus.expands, 10));
    const keys = { skip, reachedRow };
    if (reachedRow) {
      await page.keyboard.press("Enter");
      keys.opened = await eventually(expanded, (value) => value === "true", { timeoutMs: 5_000, what: "Enter to expand" }).catch(expanded);
      await page.keyboard.press("Space");
      keys.closed = await eventually(expanded, (value) => value === "false", { timeoutMs: 5_000, what: "Space to collapse" }).catch(expanded);
      await page.keyboard.press("Tab");
      keys.onTest = await focused(page);
      const keyedTest = page.waitForRequest((sent) => new URL(sent.url()).pathname === "/api/tools/web_search/test" && sent.method() === "POST", { timeout: 10_000 }).then(() => true, () => false);
      await page.keyboard.press("Enter");
      keys.ranByKey = await keyedTest;
      keys.stillClosed = (await expanded()) === "false";
      keys.keyedSettled = await eventually(() => testButton(page, "web_search").getAttribute("aria-busy", { timeout: 5_000 }), (value) => value === null, { timeoutMs: 20_000, what: "the keyed Test to finish" }).then(() => true, () => false);
      const afterTest = await focused(page);
      keys.afterTest = { row: afterTest.row, text: afterTest.text };
    }
    step(
      "Tab to the skip link and Enter skip the sidebar, Tab reaches Web search, Enter expands, Space collapses, Tab reaches Test, Enter runs it, and focus stays on Test",
      reachedRow && keys.opened === "true" && keys.closed === "false" && keys.onTest?.row === "web_search" && keys.onTest?.text === "Test" &&
        keys.ranByKey && keys.stillClosed && keys.keyedSettled && keys.afterTest?.row === "web_search" && keys.afterTest?.text === "Test",
      JSON.stringify(keys),
    );

    await page.goto(`${origin}/c/${memoryChat}`);
    await composerReady();
    await composer(page).focus();
    await page.keyboard.press("Tab");
    const afterComposer = await focused(page);
    await page.keyboard.press("Tab");
    const afterTrigger = await focused(page);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    tray = popover(page);
    const trayOpened = await tray.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if ((await focused(page)).role !== "switch") await page.keyboard.press("Tab");
    const onSwitch = await focused(page);
    const firstSwitch = tray.getByRole("switch").first();
    const switchState = () => firstSwitch.getAttribute("aria-checked", { timeout: 5_000 }).catch(() => "missing");
    const switchBefore = await switchState();
    await page.keyboard.press("Space");
    const switchAfter = await eventually(switchState, (value) => value !== switchBefore, { timeoutMs: 5_000, what: "Space to toggle the switch" }).catch(() => switchBefore);
    const stayedOpen = await tray.isVisible();
    await page.keyboard.press("Escape");
    const trayClosed = await tray.waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false);
    const backOnTrigger = await focused(page);
    step(
      "the composer tabs to + then the model chip, Enter opens the popover, Space toggles a switch in place, and Escape returns to +",
      afterComposer.toolsTrigger && afterTrigger.modelChip && trayOpened && onSwitch.role === "switch" && onSwitch.inPopover && switchBefore !== "missing" && switchAfter !== switchBefore && stayedOpen && trayClosed && backOnTrigger.toolsTrigger,
      JSON.stringify({ afterComposer, afterTrigger, trayOpened, onSwitch, switchBefore, switchAfter, stayedOpen, trayClosed, backOnTrigger }),
    );

    // --- Phones -----------------------------------------------------------------------------------
    const storageState = await page.context().storageState();
    for (const [width, height] of [[390, 844], [360, 740]]) {
      const phoneContext = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, storageState });
      contexts.push(phoneContext);
      const phone = await phoneContext.newPage();
      watch(phone, adminBodies);
      await openTools(phone);
      const rows = await phone.evaluate(() =>
        [...document.querySelectorAll("[data-tool-row]")].map((element) => {
          const expand = element.querySelector("button[aria-controls]")?.getBoundingClientRect();
          const action = [...element.querySelectorAll("button, a[href]")].find((control) => /^(Test|Set up)$/.test(control.textContent.trim()))?.getBoundingClientRect();
          return {
            id: element.getAttribute("data-tool-row"),
            expand: expand ? Math.round(expand.height) : 0,
            action: action ? { height: Math.round(action.height), below: action.top >= expand.bottom - 1 } : null,
          };
        }),
      );
      step(
        `at ${width}px each row's expand button and its Test or Set up are at least 44px tall and on separate lines`,
        rows.length === 5 && rows.every((entry) => entry.expand >= 44 && (!entry.action || (entry.action.height >= 44 && entry.action.below))),
        JSON.stringify(rows),
      );
      step(`/tools has no horizontal overflow at ${width}px`, await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await shot(`page-${width}`, phone);
      if (width === 390) {
        await expander(phone, "web_search").tap();
        const code = region(phone, "web_search").locator("pre").first();
        await code.waitFor({ timeout: 15_000 });
        const well = await code.evaluate((pre) => {
          let scroller = pre.parentElement;
          while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
          const box = scroller?.getBoundingClientRect();
          return { scrolls: Boolean(scroller), right: box ? Math.round(box.right) : null, width: window.innerWidth };
        });
        const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        step("the expanded schema scrolls sideways inside its well at 390px", well.scrolls && well.right <= well.width && fits, JSON.stringify({ ...well, fits }));
        await settled(phone, "web_search");
        await shot("expanded-390", phone);
      }

      await phone.goto(`${origin}/c/${memoryChat}`);
      await composerReady(phone);
      await trigger(phone).tap();
      const sheet = phone.locator('[data-tools-sheet="sheet"]');
      await sheet.waitFor();
      await sheet.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      const sheetRows = await sheet.locator("li").evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)));
      const sheetLink = await sheet.getByRole("link", { name: "Tools", exact: true }).isVisible();
      step(
        `at ${width}px + opens the bottom sheet with 44px switch rows and the Tools link`,
        sheetRows.length === expectedSwitches.length && sheetRows.every((rowHeight) => rowHeight >= 44) && sheetLink,
        `rows ${JSON.stringify(sheetRows)}, link ${sheetLink}`,
      );
      await shot(`sheet-${width}`, phone);
      await phone.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden" });
      const actions = await phone.evaluate(() => {
        const box = (selector) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return rect ? { left: rect.left, right: rect.right, middle: rect.top + rect.height / 2 } : null;
        };
        return { plus: box("[data-tools-trigger]"), chip: box("[data-model-chip]"), send: box('button[aria-label="Send"]'), width: window.innerWidth, overflow: document.documentElement.scrollWidth - window.innerWidth };
      });
      const { plus, chip, send: sendBox } = actions;
      const oneRow = Boolean(plus && chip && sendBox) &&
        Math.abs(plus.middle - chip.middle) <= 4 && Math.abs(chip.middle - sendBox.middle) <= 4 &&
        plus.left >= 0 && plus.right <= chip.left && chip.right <= sendBox.left && sendBox.right <= actions.width;
      step(`at ${width}px +, the model chip, and Send share one row inside the screen with no page overflow`, oneRow && actions.overflow <= 0, JSON.stringify(actions));
    }

    // --- Team and Community members -------------------------------------------------------------------
    assert.equal((await request.put(adminSettings, { data: { hostingMode: "team" } })).status(), 200, "switch to Team");
    changed.mode = true;
    memberEmail = (await seedMember()).email;
    const memberContext = await signInMember();
    contexts.push(memberContext);
    const member = await memberContext.newPage();
    watch(member, memberBodies);
    const memberVisit = await openTools(member);
    const memberRows = await member.locator("[data-tool-row]").count();
    const seen = Object.fromEntries(await Promise.all(TOOL_IDS.map(async (id) => [id, await rowState(member, id)])));
    await expander(member, "memory").click();
    const memoryConfigure = region(member, "memory").getByRole("link", { name: "Configure", exact: true });
    const configureHref = (await memoryConfigure.waitFor({ timeout: 15_000 }).then(() => true, () => false)) ? await memoryConfigure.getAttribute("href") : null;
    step(
      "a Team member sees five tools: Test and no Set up on Web search, no Set up on Code sandbox, Set up on GitHub, and Memory set up from /settings",
      memberVisit?.status() === 200 && memberRows === 5 &&
        isDeepStrictEqual(seen.web_search, { status: "Not tested", test: 1, setUp: null }) &&
        seen.run_code.setUp === null &&
        isDeepStrictEqual(seen.github, { status: "Off", test: 0, setUp: "/settings#github" }) &&
        isDeepStrictEqual(seen.memory, { status: "Not tested", test: 1, setUp: null }) && configureHref === "/settings#memory",
      JSON.stringify({ seen, configureHref }),
    );
    const memberTest = await pressTest(member, "web_search");
    const memberLine = await lineOf(member, "web_search", "status");
    step("the member's Test on Web search shows 3 results", memberTest.status() === 200 && /^3 results · /.test(memberLine), `status ${memberTest.status()}, line ${JSON.stringify(memberLine)}`);
    const adminTools = (await readJson(`${origin}/api/chats/${memoryChat}`)).disabledTools;
    const crossPatch = await member.request.patch(`${origin}/api/chats/${memoryChat}`, { data: { toolsOff: ["github", "run_code"] } });
    const adminChat = await readJson(`${origin}/api/chats/${memoryChat}`);
    step(
      "the member gets 404 on PATCH of the admin's chat, and the chat keeps its tools",
      crossPatch.status() === 404 && Array.isArray(adminTools) && isDeepStrictEqual(adminChat.disabledTools, adminTools),
      `status ${crossPatch.status()}, stored ${JSON.stringify(adminTools)} -> ${JSON.stringify(adminChat.disabledTools)}`,
    );

    assert.equal((await request.put(adminSettings, { data: { hostingMode: "community", signupMode: "invite" } })).status(), 200, "switch to Community");
    await openTools(member);
    const community = Object.fromEntries(await Promise.all(TOOL_IDS.map(async (id) => [id, await rowState(member, id)])));
    const memberLeaks = await leaks(memberBodies);
    step(
      "in Community the member keeps their own tool status and no /api/tools body holds an admin secret",
      community.web_search.status === "Working" && community.memory.status === "Not tested" && community.github.status === "Off" && memberLeaks.length === 0 && memberBodies.length > 0,
      JSON.stringify({ community, leaks: memberLeaks, bodies: memberBodies.length }),
    );

    const anonymous = await browser.newContext();
    contexts.push(anonymous);
    const signedOut = [
      (await anonymous.request.get(`${origin}/api/tools`)).status(),
      (await anonymous.request.get(`${origin}/api/tools/web_search`)).status(),
      (await anonymous.request.post(`${origin}/api/tools/web_search/test`)).status(),
    ];
    step("every /api/tools route returns 401 signed out", signedOut.every((status) => status === 401), signedOut.join(", "));
  } finally {
    try {
      // Every flag in `changed` is set after `original` is read, so a failed read restores nothing.
      if (evidence.length) fs.writeFileSync(proofFile, `${evidence.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const results = [];
      const record = async (name, run) => {
        try {
          const response = await run();
          results.push(response === undefined || response.ok() ? null : `${name} ${response.status()}`);
        } catch (error) {
          results.push(`${name} ${error instanceof Error ? error.message : error}`);
        }
      };
      if (changed.mode) {
        if (memberEmail) {
          await record("remove member", async () => {
            const { users } = await readJson(`${origin}/api/admin/users`);
            const fixture = users.find((user) => user.email === memberEmail);
            return fixture ? request.delete(`${origin}/api/admin/users/${fixture.id}`) : undefined;
          });
        }
        await record("hosting mode", () => request.put(adminSettings, { data: { hostingMode: "personal" } }));
      }
      if (changed.search || changed.tavily) {
        await record("search settings", () => request.put(adminSettings, { data: { searxngUrl: original.admin.searxngUrl, ...(changed.tavily ? { tavilyApiKey: null } : {}) } }));
      }
      if (changed.github) {
        await record("GitHub token", () => request.put(`${origin}/api/settings`, { data: { githubToken: null, githubMcpUrl: original.github.githubMcpUrl } }));
      }
      if (changed.memory) {
        await record("memory preference", () => request.patch(`${origin}/api/preferences`, { data: { memory: original.preferences.memory } }));
      }
      if (changed.tea) {
        await record("tea memory", async () => {
          const { memories } = await readJson(`${origin}/api/memories`);
          for (const memory of memories.filter((item) => item.text === TEA)) {
            const deleted = await request.delete(`${origin}/api/memories/${memory.id}`);
            if (!deleted.ok()) return deleted;
          }
          return undefined;
        });
      }
      for (const id of chats) await record(`chat ${id}`, () => request.delete(`${origin}/api/chats/${id}`));
      const problems = results.filter(Boolean);
      step("the tools scenario restores search, GitHub, Memory, and hosting mode, and removes its chats, memory, and member", problems.length === 0, problems.join("; "));
    } finally {
      await Promise.all(contexts.map((context) => context.close().catch(() => {})));
      await Promise.all([searxng.close(), mcp.close()]);
    }
  }
}
