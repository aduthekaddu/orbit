import { eventually } from "../../../../src/lib/eventually.mjs";

// Slice 21: stored artifact versions, rename, diff and download in the chat panel and on /artifacts.
// Every label and attribute the scenario finds lives here, so a UI label change is a one-line edit.
const UI = {
  chatPanel: (page) => page.getByRole("complementary", { name: "Artifact", exact: true }),
  library: (page) => page.getByRole("main"),
  preview: 'iframe[title="Artifact preview"]',
  title: (scope) => scope.getByRole("heading", { level: 2 }).first(),
  rename: (scope) => scope.getByRole("button", { name: "Rename artifact", exact: true }),
  titleInput: (scope) => scope.getByRole("textbox", { name: "Artifact title", exact: true }),
  version: (scope, number) => scope.getByRole("button", { name: `v${number}`, exact: true }),
  versions: (scope) => scope.getByRole("button", { name: /^v\d+$/ }),
  tab: (scope, name) => scope.getByRole("tab", { name, exact: true }),
  diffPanel: (scope) => scope.getByRole("tabpanel", { name: "Diff", exact: true }),
  diffBase: (scope) => scope.getByRole("combobox").first(),
  option: (page, name) => page.getByRole("option", { name, exact: true }),
  button: (scope, name) => scope.getByRole("button", { name, exact: true }),
  back: (scope) => scope.getByRole("button", { name: "Back", exact: true }),
  openInChat: (scope) => scope.getByRole("link", { name: "Open in chat", exact: true }),
  card: (reply, title) => reply.getByRole("button", { name: `Open ${title}`, exact: true }),
  cards: (reply) => reply.getByRole("button", { name: /^Open / }),
  sidebarLink: (page) => page.getByRole("link", { name: "Artifacts", exact: true }),
  search: (scope) => scope.getByRole("searchbox").or(scope.getByRole("textbox", { name: /search/i })).first(),
  kind: (scope, name) => scope.getByRole("button", { name, exact: true }).or(scope.getByRole("radio", { name, exact: true })).first(),
  rows: (scope) => scope.locator("[data-artifact-row]"),
  row: (scope, lineageId) => scope.locator(`[data-artifact-row="${lineageId}"]`),
  pageHeading: (scope) => scope.getByRole("heading", { name: "Artifacts", exact: true }),
  empty: "No artifacts",
  noMatch: "No matching artifacts",
  notFound: "Artifact not found",
  deleteToast: (page) => page.getByRole("status").filter({ hasText: "Chat deleted" }),
};
const UI_WAIT = 5_000;
const REPLY_WAIT = 30_000;

async function need(locator, what, timeout = UI_WAIT) {
  try {
    await locator.waitFor({ timeout });
  } catch {
    throw new Error(`no ${what} within ${timeout}ms`);
  }
  return locator;
}

async function frameSecurity(frame, origin) {
  return frame.locator("body").evaluate(async (_body, appOrigin) => {
    let parentBlocked = false;
    let cookiesBlocked = false;
    let fetchBlocked = false;
    try { void parent.document; } catch { parentBlocked = true; }
    try { void document.cookie; } catch { cookiesBlocked = true; }
    try { await fetch(`${appOrigin}/api/chats`); } catch { fetchBlocked = true; }
    return { parentBlocked, cookiesBlocked, fetchBlocked };
  }, origin);
}

const noOverflow = (target) => target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const settle = (locator) => locator.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => null))));

async function shortTargets(locators) {
  const short = [];
  for (const locator of locators) {
    for (const element of await locator.all()) {
      if (!await element.isVisible()) continue;
      const box = await element.boundingBox();
      if (box && box.height < 43.5) short.push(`${(await element.innerText()).trim().slice(0, 30) || await element.getAttribute("aria-label")} ${box.height}px`);
    }
  }
  return short;
}

export default async function artifactsPage({ page, origin, step, shot, signInMember }) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const browser = page.context().browser();
  const panel = UI.chatPanel(page);
  const library = UI.library(page);
  const iframe = page.locator(UI.preview);
  const composer = page.getByPlaceholder("Ask anything");
  const replies = page.locator('[data-message-role="assistant"]');
  const reply = replies.last();
  const state = {};

  async function section(name, run) {
    try { await run(); }
    catch (error) { step(name, false, error.message.split("\n")[0]); }
  }
  async function json(response, what) {
    if (!response.ok()) throw new Error(`${what} answered ${response.status()}`);
    return response.json();
  }
  const get = (pathname, scope = page) => scope.request.get(`${origin}${pathname}`);
  const chatArtifacts = async (chatId) => (await json(await get(`/api/chats/${chatId}/artifacts`), `GET /api/chats/${chatId}/artifacts`)).artifacts;
  const listArtifacts = async (query = "") => json(await get(`/api/artifacts${query}`), `GET /api/artifacts${query}`);

  async function newChat() {
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${id}`);
    return id;
  }
  async function settled() {
    await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: REPLY_WAIT });
    await reply.locator('[data-status="complete"]').waitFor({ timeout: REPLY_WAIT });
    return reply.getAttribute("data-message-id");
  }
  async function send(text) {
    const before = await replies.count();
    await composer.fill(text);
    await composer.press("Enter");
    await replies.nth(before).waitFor({ timeout: REPLY_WAIT });
    return settled();
  }
  // The mock numbers artifact-version replies per process, so read each reply's number from the saved chat.
  async function versionText(chatId, messageId) {
    const tree = await json(await get(`/api/chats/${chatId}`), `GET /api/chats/${chatId}`);
    const message = tree.messages.map((entry) => entry.message ?? entry).find((entry) => entry.id === messageId);
    const text = (message?.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
    const found = /Version \d+/.exec(text)?.[0];
    if (!found) throw new Error(`reply ${messageId} holds no Version line`);
    return found;
  }
  const previewShows = (text, frameOf = iframe) => need(frameOf.contentFrame().getByText(text, { exact: true }), `preview showing ${text}`, 10_000);
  const query = (name, url = page.url()) => new URL(url).searchParams.get(name);

  // Routes. On the pre-Slice-21 build both answer 404, so this is the first FAIL line.
  const pageStatus = (await get("/artifacts")).status();
  const apiStatus = (await get("/api/artifacts")).status();
  step("GET /artifacts returns 200", pageStatus === 200, `status ${pageStatus}`);
  step("GET /api/artifacts returns 200", apiStatus === 200, `status ${apiStatus}`);

  await section("versions across regenerate, prompt edit and branch switch", async () => {
    state.chatId = await newChat();
    const m1 = await send("[qa:artifact-version]");
    await reply.getByRole("button", { name: "Regenerate", exact: true }).click();
    await reply.locator("[data-branch-picker]").getByText("2 / 2", { exact: true }).waitFor({ timeout: REPLY_WAIT });
    const m2 = await settled();
    const prompt = page.locator("[data-turn-id]").first();
    await prompt.hover();
    await prompt.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit message" }).fill("[qa:artifact-version]");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await page.locator("[data-turn-id] [data-branch-picker]").getByText("2 / 2", { exact: true }).waitFor({ timeout: REPLY_WAIT });
    const m3 = await settled();
    state.messages = [m1, m2, m3];
    state.texts = [await versionText(state.chatId, m1), await versionText(state.chatId, m2), await versionText(state.chatId, m3)];
    step("three replies hold three different versions", new Set(state.texts).size === 3, JSON.stringify(state.texts));

    await need(UI.cards(reply), "artifact card on the edited-prompt reply").then((card) => card.click());
    await need(iframe, "preview frame");
    const strip = await need(UI.version(panel, 3), "v3 button in the chat panel");
    step("the chat panel shows v1, v2 and v3", await UI.versions(panel).allInnerTexts().then((texts) => texts.join(" ") === "v1 v2 v3"), JSON.stringify(await UI.versions(panel).allInnerTexts()));
    step("v3 is the current version", await strip.getAttribute("aria-current") === "true");
    step("the thread card shows HTML · v3", (await reply.innerText()).includes("HTML · v3"), JSON.stringify(await reply.innerText()));
    await previewShows(state.texts[2]);
    await shot("versions");

    const stored = await chatArtifacts(state.chatId);
    const entry = stored[`${m3}.0.0`];
    if (!entry) throw new Error(`GET /api/chats/<id>/artifacts has no key ${m3}.0.0: ${JSON.stringify(Object.keys(stored))}`);
    state.lineageId = entry.lineageId;
    state.versions = entry.versions;
    step("the stored lineage lists the three replies oldest first", JSON.stringify(entry.versions.map((version) => version.messageId)) === JSON.stringify(state.messages), JSON.stringify(entry.versions.map((version) => [version.number, version.messageId])));

    await UI.version(panel, 1).click();
    await eventually(() => query("artifact"), (key) => key === `${m1}.0.0`, { timeoutMs: 10_000, what: "?artifact= to name v1" });
    await previewShows(state.texts[0]);
    step("v1 opens Version 1 on its own branch", await reply.getAttribute("data-message-id") === m1 && await UI.version(panel, 1).getAttribute("aria-current") === "true", `reply ${await reply.getAttribute("data-message-id")}`);
  });

  await section("inline rename and download in the chat panel", async () => {
    const lineage = async () => Object.values(await chatArtifacts(state.chatId)).filter((entry) => entry.lineageId === state.lineageId);
    await (await need(UI.rename(panel), "Rename artifact button")).click();
    const input = await need(UI.titleInput(panel), "Artifact title input");
    step("rename opens prefilled with Counter", await input.inputValue() === "Counter", await input.inputValue());
    await input.fill("Tally");
    await input.press("Enter");
    await need(UI.title(panel).getByText("Tally", { exact: true }), "Tally in the panel header");
    await need(UI.card(reply, "Tally"), "Open Tally card in the thread");
    const renamed = await eventually(lineage, (rows) => rows.length === 3 && rows.every((row) => row.title === "Tally"), { timeoutMs: 5_000, what: "every stored version titled Tally" });
    step("rename shows in the header, the card and every stored version", renamed.length === 3);
    const download = page.waitForEvent("download");
    await UI.button(panel, "Download").click();
    const name = (await download).suggestedFilename();
    step("Download is named tally.html", name === "tally.html", name);
    await shot("renamed");

    await UI.rename(panel).click();
    await UI.titleInput(panel).fill("Discarded");
    await UI.titleInput(panel).press("Escape");
    await UI.titleInput(panel).waitFor({ state: "hidden", timeout: UI_WAIT });
    step("Escape in rename cancels and keeps the panel open", await panel.isVisible() && Boolean(query("artifact")) && await UI.title(panel).innerText() === "Tally", await UI.title(panel).innerText());

    await UI.rename(panel).click();
    await UI.titleInput(panel).fill("");
    await UI.titleInput(panel).press("Enter");
    await need(UI.title(panel).getByText("Counter", { exact: true }), "Counter back in the header");
    const reset = await eventually(lineage, (rows) => rows.every((row) => row.title === "Counter" && row.userTitle === null), { timeoutMs: 5_000, what: "a blank rename to clear userTitle" });
    step("a blank rename resets to Counter", reset.length === 3);
    await UI.rename(panel).click();
    await UI.titleInput(panel).fill("Tally");
    await UI.titleInput(panel).press("Enter");
    await need(UI.title(panel).getByText("Tally", { exact: true }), "Tally in the header again");
  });

  await section("code diff in the chat panel", async () => {
    await (await need(UI.version(panel, 3), "v3 button")).click();
    await previewShows(state.texts[2]);
    await (await need(UI.tab(panel, "Diff"), "Diff tab")).click();
    const diff = await need(UI.diffPanel(panel), "Diff tab panel");
    await need(diff.getByText(state.texts[2], { exact: false }), `${state.texts[2]} in the diff`);
    const text = await diff.innerText();
    step("Diff on v3 compares against v2 by default", await UI.diffBase(diff).innerText().then((base) => base.includes("v2")), await UI.diffBase(diff).innerText());
    step("Diff marks the old Version line removed and the new one added",
      new RegExp(`-[^\\n]*${state.texts[1]}`).test(text) && new RegExp(`\\+[^\\n]*${state.texts[2]}`).test(text) && text.includes("+1") && text.includes("-1"), JSON.stringify(text.slice(0, 400)));
    await UI.diffBase(diff).click();
    await (await need(UI.option(page, "v1"), "v1 option in the base selector")).click();
    await need(diff.getByText(state.texts[0], { exact: false }), `${state.texts[0]} in the diff`);
    step("switching the base to v1 compares v1 with v3", !(await diff.innerText()).includes(state.texts[1]));
    await shot("diff");
  });

  await section("card keys match the stored rows", async () => {
    const chatId = await newChat();
    const messageId = await send("[qa:artifact-multiple]");
    const stored = Object.keys(await chatArtifacts(chatId)).sort();
    const shown = [];
    for (let index = 0; index < 3; index += 1) {
      await UI.cards(reply).nth(index).click();
      shown.push(await eventually(() => query("artifact"), (key) => Boolean(key) && !shown.includes(key), { timeoutMs: 5_000, what: `?artifact= for card ${index}` }));
    }
    await page.keyboard.press("Escape");
    const expected = [0, 1, 2].map((index) => `${messageId}.0.${index}`);
    step("each card's key equals its stored row key", JSON.stringify([...shown].sort()) === JSON.stringify(stored) && JSON.stringify(shown) === JSON.stringify(expected), `cards ${JSON.stringify(shown)} rows ${JSON.stringify(stored)}`);
  });

  await section("the Artifacts library on desktop", async () => {
    const v1 = state.versions?.[0];
    if (!v1) throw new Error("no stored Counter lineage from the versions section");
    await newChat();
    await send("[qa:artifact-svg]");
    await (await need(UI.sidebarLink(page), "Artifacts link in the sidebar")).click();
    await page.waitForURL((url) => url.pathname === "/artifacts", { timeout: UI_WAIT });
    await need(UI.pageHeading(library), "Artifacts heading");
    const row = await need(UI.row(library, state.lineageId), "Tally row");
    await need(iframe, "preview frame in the right pane");
    const [rowBox, frameBox] = [await row.boundingBox(), await iframe.boundingBox()];
    step("the library opens in two panes with a preview", rowBox && frameBox && rowBox.x + rowBox.width <= frameBox.x + 1, JSON.stringify({ rowBox, frameBox }));
    step("the Tally row shows HTML · 3 versions", (await row.innerText()).includes("HTML · 3 versions"), JSON.stringify(await row.innerText()));
    await shot("list");

    const search = await need(UI.search(library), "artifact search field");
    await search.fill("Tally");
    await need(UI.row(library, state.lineageId), "Tally row for the search Tally");
    await search.fill(`Tally ${state.texts[1]}`);
    await need(UI.row(library, state.lineageId), `Tally row for the search Tally ${state.texts[1]}`);
    step("search finds Tally by its title and by a later version's code", true);
    await shot("search");
    await search.fill("zzqxnomatch");
    await need(library.getByText(UI.noMatch, { exact: true }), UI.noMatch);
    step("a search with no hit says No matching artifacts", true);
    await search.fill("");

    await UI.kind(library, "HTML").click();
    await need(UI.row(library, state.lineageId), "Tally row under HTML");
    const htmlRows = await UI.rows(library).allInnerTexts();
    await UI.kind(library, "SVG").click();
    await UI.row(library, state.lineageId).waitFor({ state: "hidden", timeout: UI_WAIT });
    const svgRows = await UI.rows(library).allInnerTexts();
    step("the HTML and SVG filters show only their kind", htmlRows.every((text) => text.includes("HTML")) && svgRows.length > 0 && svgRows.every((text) => text.includes("SVG")), JSON.stringify({ htmlRows, svgRows }));
    await UI.kind(library, "All").click();

    await UI.row(library, state.lineageId).click();
    await need(UI.title(library).getByText("Tally", { exact: true }), "Tally in the detail header");
    await UI.version(library, 1).click();
    await previewShows(state.texts[0]);
    await eventually(() => query("id"), (id) => id === v1.id, { timeoutMs: UI_WAIT, what: "?id= to name v1" });
    await UI.version(library, 3).click();
    await previewShows(state.texts[2]);
    const onV3 = await eventually(() => query("id"), (id) => id === state.versions[2].id, { timeoutMs: UI_WAIT, what: "?id= to name v3" }).then(() => true, () => false);
    step("v1 and v3 switch the live preview", onV3, page.url());
    await UI.tab(library, "Diff").click();
    const diff = await need(UI.diffPanel(library), "Diff tab panel in the library");
    await need(diff.getByText(state.texts[2], { exact: false }), `${state.texts[2]} in the library diff`);
    await UI.version(library, 1).click();
    await need(diff.getByText(state.texts[0], { exact: false }), `${state.texts[0]} in the library diff`);
    step("v1 and v3 switch the diff", true);

    await page.goto(`${origin}/artifacts?id=${encodeURIComponent(v1.id)}`);
    await need(UI.version(library, 1), "v1 button after reload");
    await previewShows(state.texts[0]);
    step("reloading /artifacts?id=<v1> reopens v1", await UI.version(library, 1).getAttribute("aria-current") === "true");
    const download = page.waitForEvent("download");
    await UI.button(library, "Download").click();
    const name = (await download).suggestedFilename();
    step("library Download is named tally.html", name === "tally.html", name);
    const security = await frameSecurity(iframe.contentFrame(), origin);
    step("the library preview cannot read parent.document, document.cookie or fetch the app", security.parentBlocked && security.cookiesBlocked && security.fetchBlocked, JSON.stringify(security));
    step("the library preview sandbox is exactly allow-scripts", await iframe.getAttribute("sandbox") === "allow-scripts", await iframe.getAttribute("sandbox"));

    const target = (await UI.row(library, state.lineageId).evaluate((node) => node.tabIndex >= 0)) ? UI.row(library, state.lineageId) : UI.row(library, state.lineageId).locator('button, a, [tabindex="0"]').first();
    await target.focus();
    await page.keyboard.press("Enter");
    await eventually(() => query("id"), (id) => id === state.versions[2].id, { timeoutMs: UI_WAIT, what: "Enter on the focused row to open its newest version" });
    await UI.tab(library, "Code").focus();
    await page.keyboard.press("ArrowRight");
    step("Enter opens a focused row and ArrowRight reaches the Diff tab", await UI.tab(library, "Diff").evaluate((node) => node === document.activeElement));

    await page.goto(`${origin}/artifacts?id=${encodeURIComponent(v1.id)}`);
    await (await need(UI.openInChat(library), "Open in chat link")).click();
    await page.waitForURL((url) => url.pathname === `/c/${state.chatId}`, { timeout: 10_000 });
    await previewShows(state.texts[0]);
    step("Open in chat lands on v1's branch with Version 1 open",
      query("artifact") === v1.key && await reply.getAttribute("data-message-id") === v1.messageId, page.url());
    await shot("open-in-chat");

    await page.goto(`${origin}/artifacts?id=not-a-real-id`);
    await need(library.getByText(UI.notFound, { exact: true }), UI.notFound);
    step("an unknown ?id= says Artifact not found", true);
  });

  await section("deleting a chat removes its artifacts", async () => {
    const token = `quokka${Date.now().toString(36)}`;
    const chatId = await newChat();
    await send("[qa:artifact-html]");
    await reply.getByRole("button", { name: "Edit code", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit html block", exact: true });
    await editor.fill((await editor.inputValue()).replace("Artifact HTML", `Artifact ${token}`));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    const before = await eventually(() => listArtifacts(`?q=${token}`), (found) => found.items.length === 1, { timeoutMs: UI_WAIT, what: `search ${token} to find the edited artifact` });
    const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "New chat" }) }).first();
    const link = sidebar.locator(`a[href="/c/${chatId}"]`);
    await link.hover();
    await link.locator("..").getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await need(UI.deleteToast(page), "Chat deleted toast");
    await UI.deleteToast(page).waitFor({ state: "hidden", timeout: 15_000 });
    await eventually(async () => (await get(`/api/chats/${chatId}`)).status(), (status) => status === 404, { timeoutMs: 10_000, what: "the deleted chat to answer 404" });
    const after = await listArtifacts(`?q=${token}`);
    const listed = (await listArtifacts()).items.filter((item) => item.chatId === chatId);
    await page.goto(`${origin}/artifacts`);
    await UI.search(library).fill(token);
    await need(library.getByText(UI.noMatch, { exact: true }), `${UI.noMatch} after the delete`);
    step("a deleted chat's artifacts leave the list and the search", before.items[0].chatId === chatId && after.items.length === 0 && listed.length === 0, JSON.stringify({ after: after.items.length, listed: listed.length }));
  });

  await section("artifacts stay private to their owner", async () => {
    const adminArtifact = state.versions?.[0]?.id ?? "missing";
    const routes = [
      ["GET", "/api/artifacts"],
      ["GET", `/api/artifacts/${adminArtifact}`],
      ["PATCH", `/api/artifacts/${adminArtifact}`],
      ["GET", `/api/chats/${state.chatId}/artifacts`],
    ];
    const call = (scope, [method, pathname]) => scope.request.fetch(`${origin}${pathname}`, method === "PATCH" ? { method, data: { title: "Stolen" } } : { method });
    const anonymous = await browser.newContext();
    try {
      const statuses = [];
      for (const route of routes) statuses.push((await call(anonymous, route)).status());
      step("signed-out requests to the four artifact routes get 401", statuses.every((status) => status === 401), JSON.stringify(routes.map(([method, pathname], index) => `${method} ${pathname} ${statuses[index]}`)));
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(`${origin}/artifacts`);
      step("a signed-out visit to /artifacts redirects to /login", new URL(anonymousPage.url()).pathname === "/login", anonymousPage.url());
    } finally {
      await anonymous.close();
    }

    const before = await json(await get("/api/admin/settings"), "GET /api/admin/settings");
    const team = await page.request.put(`${origin}/api/admin/settings`, { data: { hostingMode: "team" } });
    if (!team.ok()) throw new Error(`switching to Team answered ${team.status()}`);
    let member;
    try {
      member = await signInMember();
      const memberPage = await member.newPage();
      await memberPage.goto(`${origin}/artifacts`);
      await need(memberPage.getByText(UI.empty, { exact: true }), `${UI.empty} for the member`);
      const listed = await member.request.get(`${origin}/api/artifacts`);
      const items = listed.ok() ? (await listed.json()).items : null;
      step("a member sees No artifacts and an empty list", Array.isArray(items) && items.length === 0, `status ${listed.status()} items ${JSON.stringify(items)}`);
      await shot("empty", memberPage);
      const statuses = [];
      for (const route of routes.slice(1)) statuses.push((await call(member, route)).status());
      step("a member gets 404 for the admin's artifact and chat artifacts", statuses.every((status) => status === 404), JSON.stringify(statuses));
      const still = await chatArtifacts(state.chatId);
      step("the member's rename attempt changed nothing", Object.values(still).every((entry) => entry.lineageId !== state.lineageId || entry.title === "Tally"));
    } finally {
      await member?.close();
      const users = await json(await get("/api/admin/users"), "GET /api/admin/users");
      for (const user of users.users.filter((entry) => entry.email === "member@orbit.local")) await page.request.delete(`${origin}/api/admin/users/${user.id}`);
      const restored = await page.request.put(`${origin}/api/admin/settings`, { data: { hostingMode: before.hostingMode } });
      step("the scenario restores the hosting mode and removes the member", restored.ok() && (await restored.json()).hostingMode === before.hostingMode, `status ${restored.status()}`);
    }
  });

  async function mobile(width, height) {
    const label = `${width}x${height}`;
    await section(`the Artifacts library on a ${label} phone`, async () => {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      try {
        await context.addCookies(await page.context().cookies());
        const phone = await context.newPage();
        const phoneLibrary = UI.library(phone);
        const phoneFrame = phone.locator(UI.preview);
        await phone.goto(`${origin}/artifacts`);
        const row = await need(UI.row(phoneLibrary, state.lineageId), `Tally row at ${label}`);
        step(`${label}: the list opens first with no preview`, !await phoneFrame.isVisible() && await noOverflow(phone));
        const short = await shortTargets([UI.rows(phoneLibrary), ...["All", "HTML", "SVG", "React"].map((name) => UI.kind(phoneLibrary, name))]);
        step(`${label}: list rows and filter pills are at least 44px tall`, short.length === 0, JSON.stringify(short));
        await shot(`list-${width}`, phone);

        await row.tap();
        await eventually(() => query("id", phone.url()), Boolean, { timeoutMs: UI_WAIT, what: "?id= after tapping the row" });
        await need(UI.back(phoneLibrary), `Back button at ${label}`);
        await need(UI.version(phoneLibrary, 3), `v3 button at ${label}`);
        await settle(phoneLibrary);
        const views = {};
        views.preview = await noOverflow(phone);
        if (width === 390) await shot("detail-390", phone);
        await UI.tab(phoneLibrary, "Code").tap();
        views.code = await noOverflow(phone);
        await UI.tab(phoneLibrary, "Diff").tap();
        await need(UI.diffPanel(phoneLibrary).getByText(state.texts[2], { exact: false }), `diff at ${label}`);
        views.diff = await noOverflow(phone);
        step(`${label}: preview, code and diff have no sideways scroll`, Object.values(views).every(Boolean), JSON.stringify(views));
        const detailShort = await shortTargets([UI.back(phoneLibrary), UI.versions(phoneLibrary), phoneLibrary.getByRole("tab"), UI.button(phoneLibrary, "Download"), UI.rename(phoneLibrary)]);
        step(`${label}: Back, versions, tabs and actions are at least 44px tall`, detailShort.length === 0, JSON.stringify(detailShort));
        await shot(`diff-${width}`, phone);

        await UI.rename(phoneLibrary).tap();
        const fontSize = await UI.titleInput(phoneLibrary).evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
        step(`${label}: the rename field is at least 16px so iOS does not zoom`, fontSize >= 16, `${fontSize}px`);
        await UI.titleInput(phoneLibrary).press("Escape");

        await UI.back(phoneLibrary).tap();
        await need(UI.row(phoneLibrary, state.lineageId), `list after Back at ${label}`);
        step(`${label}: Back returns to the list`, query("id", phone.url()) === null, phone.url());
        await UI.row(phoneLibrary, state.lineageId).tap();
        await need(UI.back(phoneLibrary), `detail again at ${label}`);
        await phone.goBack();
        await need(UI.row(phoneLibrary, state.lineageId), `list after browser Back at ${label}`);
        step(`${label}: browser Back returns to the list`, query("id", phone.url()) === null && !await UI.back(phoneLibrary).isVisible(), phone.url());
      } finally {
        await context.close();
      }
    });
  }
  await mobile(390, 844);
  await mobile(360, 740);
}
