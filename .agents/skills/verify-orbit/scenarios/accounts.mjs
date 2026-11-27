import assert from "node:assert/strict";

const teamEmail = "member-team@orbit.local";
const communityEmail = "member-community@orbit.local";
const password = "orbit-accounts-fixture";
const desktop = { width: 1280, height: 800 };

function heading(page, name) {
  return page.getByRole("heading", { name, exact: true });
}

function apiResponse(page, path, method) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function select(page, field, value) {
  await page.getByRole("combobox", { name: field, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

async function chooseDefault(page) {
  const form = page.getByRole("form", { name: "Default model", exact: true });
  await form.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "mock-genui", exact: true }).click();
  await form.getByRole("radio", { name: "Low", exact: true }).click();
  const saved = apiResponse(page, "/api/preferences/model", "PUT");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal((await saved).status(), 200, "save each member's own default model");
}

async function sendChat(page, prompt, reply = "pong") {
  const composer = page.getByPlaceholder("Ask anything", { exact: true });
  const replies = page.locator('[data-message-role="assistant"]').getByText(reply, { exact: true });
  const before = await replies.count();
  await composer.fill(prompt);
  await composer.press("Enter");
  await replies.nth(before).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  return new URL(page.url()).pathname;
}

async function signup(page, email, { doubleSubmit = false } = {}) {
  await page.getByLabel("Name", { exact: true }).fill("Orbit Member");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const response = apiResponse(page, "/api/auth/sign-up/email", "POST");
  const button = page.getByRole("button", { name: "Create account", exact: true });
  if (doubleSubmit) {
    await button.evaluate((target) => { target.click(); target.click(); });
  } else {
    await button.click();
  }
  assert.equal((await response).status(), 200, "signup succeeds");
  await page.waitForURL((url) => url.pathname.startsWith("/c/"));
}

export default async function accounts({ page, origin, step, shot, mockUrl }) {
  await page.goto(`${origin}/admin`);
  const hosting = page.getByRole("combobox", { name: "Hosting mode", exact: true });
  if (!step("Admin has Hosting controls", await heading(page, "Hosting").isVisible() && await hosting.isVisible(), "Hosting controls are missing on /admin")) return;

  const request = page.request;
  const browser = page.context().browser();
  const contexts = [];
  const adminSettings = `${origin}/api/admin/settings`;
  const usersUrl = `${origin}/api/admin/users`;
  const invitesUrl = `${origin}/api/admin/invites`;
  const getJSON = async (url, actor = request) => {
    const response = await actor.get(url);
    assert.equal(response.status(), 200, `read ${new URL(url).pathname}`);
    return response.json();
  };
  const accountsList = async () => (await getJSON(usersUrl)).users;
  const invites = async () => (await getJSON(invitesUrl)).invites;

  async function newPage(options = { viewport: desktop }) {
    const context = await browser.newContext(options);
    contexts.push(context);
    return context.newPage();
  }

  async function hostingMode(label, expected = 200) {
    const response = apiResponse(page, "/api/admin/settings", "PUT");
    await select(page, "Hosting mode", label);
    assert.equal((await response).status(), expected, `switch to ${label}`);
    await hosting.waitFor();
  }

  async function createInvite() {
    const response = apiResponse(page, "/api/admin/invites", "POST");
    await page.getByRole("button", { name: "Create invite", exact: true }).click();
    assert.equal((await response).status(), 201, "create an invite");
    const link = page.getByRole("textbox", { name: "Invite link", exact: true });
    await link.waitFor();
    return link.inputValue();
  }

  function removeButton(target, email) {
    return target.getByRole("button", { name: `Remove ${email}`, exact: true });
  }

  async function fits(target, width, name) {
    step(`${name} fits ${width} pixels`, await target.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth));
  }

  const team = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const signedOut = await newPage();
  const community = await newPage();

  try {
    assert.equal((await accountsList()).length, 1, "start with only the verify admin");
    assert.equal((await getJSON(adminSettings)).hostingMode, "personal");
    assert.equal(await heading(page, "Invites").count(), 0);
    assert.equal(await hosting.innerText(), "Personal");
    await hostingMode("Team");
    await heading(page, "Invites").waitFor();
    step("Team shows Invites and keeps Signup closed", await heading(page, "Signup").count() === 0 && !(await getJSON(`${origin}/api/setup`)).signupOpen);
    await shot("hosting");

    const teamLink = await createInvite();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    step("Copy places the one-time link on the clipboard", await page.evaluate(async (link) => await navigator.clipboard.readText() === link, teamLink));
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await shot("invite-created");
    await page.reload();
    const pending = await invites();
    await page.getByRole("button", { name: "Revoke", exact: true }).waitFor();
    step("Reload keeps the pending invite and hides the one-time link",
      pending.length === 1 && pending[0].expiresAt && await page.getByRole("textbox", { name: "Invite link", exact: true }).count() === 0 &&
      await page.getByText(/Expires/).isVisible());
    await team.goto(teamLink);
    const teamSignup = team.getByRole("button", { name: "Create account", exact: true });
    await teamSignup.waitFor();
    await teamSignup.click();
    assert.equal(await team.getByLabel("Name", { exact: true }).evaluate((input) => input.validity.valueMissing), true, "blank signup stays on the form");
    await team.getByLabel("Name", { exact: true }).fill("A".repeat(500));
    await team.getByLabel("Email", { exact: true }).fill("invalid-email");
    assert.equal(await team.getByLabel("Email", { exact: true }).evaluate((input) => input.validity.typeMismatch), true, "email field rejects a wrong format");
    await fits(team, 390, "Invite signup with long input");
    await team.reload();
    await teamSignup.waitFor();
    await fits(team, 390, "Invite signup after refresh");
    await shot("invite-signup-390", team);
    await signedOut.goto(teamLink);
    await signedOut.getByRole("button", { name: "Create account", exact: true }).waitFor();
    await shot("invite-signup", signedOut);
    let submissions = 0;
    team.on("request", (outgoing) => { if (new URL(outgoing.url()).pathname === "/api/auth/sign-up/email") submissions += 1; });
    await signup(team, teamEmail, { doubleSubmit: true });
    step("Double submit creates one Team member with one signup request", submissions === 1 && (await accountsList()).filter((account) => account.email === teamEmail).length === 1);
    await heading(team, "Default model").waitFor();
    step("Team first visit offers the shared models and hides connection add",
      await heading(team, "Connect a provider").count() === 0 && await heading(team, "Add connection").count() === 0);
    await chooseDefault(team);
    const teamChat = await sendChat(team, "[qa:plain] Say pong for the Team browser check.");
    step("Team member can chat using their own model default", teamChat.startsWith("/c/"));
    await sendChat(team, "[qa:remember] Remember I practice the cello.", "Saved.");

    await team.goto(`${origin}/settings`);
    for (const name of ["Appearance", "Default model", "Models", "Memory", "GitHub"]) await heading(team, name).waitFor();
    step("Team settings hides the Connections management card", await heading(team, "Connections").count() === 0);
    await fits(team, 390, "Team settings");
    await shot("team-member-settings-390", team);
    const desktopTeam = await newPage({ viewport: desktop, storageState: await team.context().storageState() });
    await desktopTeam.goto(`${origin}/settings`);
    await heading(desktopTeam, "Models").waitFor();
    await shot("team-member-settings", desktopTeam);
    const shared = (await getJSON(`${origin}/api/connections`, team.request)).connections;
    assert.ok(shared.length > 0);
    step("Team connections expose only id, kind, and label", shared.every((connection) => Object.keys(connection).sort().join(",") === "id,kind,label"));
    const blockedAdd = await team.request.post(`${origin}/api/connections`, {
      data: { kind: "openai-compatible", label: "Refused", baseUrl: mockUrl, apiKey: "test-key-not-real" },
    });
    step("Team member cannot create connections", blockedAdd.status() === 403, `POST ${blockedAdd.status()}`);

    await signedOut.goto(teamLink);
    await heading(signedOut, "Invite not valid").waitFor();
    step("A spent invite renders the invalid state", await signedOut.getByRole("button", { name: "Create account", exact: true }).count() === 0);
    await shot("invite-reused", signedOut);

    await page.goto(`${origin}/admin`);
    const signedInLink = await createInvite();
    const beforeVisit = await invites();
    const landing = await request.get(signedInLink, { maxRedirects: 0 });
    assert.equal(landing.status(), 307, "signed-in invite visit redirects");
    assert.equal(new URL(landing.headers().location, origin).pathname, "/");
    await signedOut.goto(signedInLink);
    assert.equal(await signedOut.getByRole("button", { name: "Create account", exact: true }).isVisible(), true, "signed-in visit leaves an invite claimable");
    step("Signed-in invite visit redirects without claiming the link", beforeVisit.length === 1 && (await invites()).length === 1);
    const revoked = apiResponse(page, `/api/admin/invites/${beforeVisit[0].id}`, "DELETE");
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    assert.equal((await revoked).status(), 200, "revoke the invite");
    await signedOut.reload();
    await heading(signedOut, "Invite not valid").waitFor();

    await hostingMode("Personal", 409);
    await page.getByRole("alert").filter({ hasText: "Remove other accounts first." }).waitFor();
    step("Personal change is refused while another account exists", await hosting.innerText() === "Team");
    const privateChat = await page.goto(`${origin}${teamChat}`);
    const { memories } = await getJSON(`${origin}/api/memories`);
    step("Admin cannot open the member chat or see the member memory",
      privateChat?.status() === 404 && !memories.some((entry) => entry.text.includes("practice the cello")));
    const member = (await accountsList()).find((account) => account.email === teamEmail);
    assert.ok(member, "Team member appears in Users");

    await page.goto(`${origin}/admin`);
    for (const width of [1280, 390, 360]) {
      const admin = width === 1280 ? page : await newPage({
        viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
        storageState: await page.context().storageState(),
      });
      if (admin !== page) await admin.goto(`${origin}/admin`);
      for (const section of ["Hosting", "Invites", "Users"]) {
        await heading(admin, section).scrollIntoViewIfNeeded();
        await fits(admin, width, section);
        if (width !== 1280) await shot(`${section.toLowerCase()}-${width}`, admin);
      }
      await removeButton(admin, teamEmail).click();
      const dialog = admin.getByRole("dialog", { name: "Remove account", exact: true });
      await dialog.getByText(teamEmail, { exact: true }).waitFor();
      await fits(admin, width, "Remove dialog");
      await shot(width === 1280 ? "remove-dialog" : `remove-dialog-${width}`, admin);
      if (width !== 360) {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      } else {
        const removed = apiResponse(admin, `/api/admin/users/${member.id}`, "DELETE");
        await dialog.getByRole("button", { name: "Remove", exact: true }).click();
        assert.equal((await removed).status(), 200, "remove the member");
        await dialog.waitFor({ state: "hidden" });
      }
    }

    assert.equal((await team.request.get(`${origin}/api/chats`)).status(), 401, "removed member's session immediately fails");
    await team.goto(`${origin}${teamChat}`);
    await team.waitForURL((url) => url.pathname === "/login");
    await shot("removed-member-login-390", team);
    await desktopTeam.goto(`${origin}${teamChat}`);
    await desktopTeam.waitForURL((url) => url.pathname === "/login");
    await shot("removed-member-login", desktopTeam);
    await signedOut.goto(teamLink);
    await heading(signedOut, "Invite not valid").waitFor();
    step("Removed member is signed out and the link stays spent", true);
    await page.reload();
    await hostingMode("Personal");
    await heading(page, "Invites").waitFor({ state: "hidden" });
    step("Admin can restore Personal after member removal", (await getJSON(adminSettings)).hostingMode === "personal");

    await hostingMode("Community");
    await selectSignupOpen();
    assert.deepEqual(await getJSON(`${origin}/api/setup`), { signupOpen: true });
    await community.goto(`${origin}/signup`);
    await signup(community, communityEmail);
    await community.getByRole("button", { name: "OpenAI-compatible", exact: true }).click();
    await community.getByLabel("Base URL", { exact: true }).fill("http://10.0.0.1/v1");
    await community.getByLabel("API key", { exact: true }).fill("test-key-not-real");
    let added = apiResponse(community, "/api/connections", "POST");
    await community.getByRole("button", { name: "Add", exact: true }).click();
    assert.equal((await added).status(), 400, "Community refuses a private provider URL");
    await community.getByRole("alert").filter({ hasText: "Use a public URL." }).waitFor();
    await shot("community-private-url", community);
    await community.getByLabel("Base URL", { exact: true }).fill(mockUrl);
    added = apiResponse(community, "/api/connections", "POST");
    await community.getByRole("button", { name: "Add", exact: true }).click();
    assert.equal((await added).status(), 201, "Community may add the local mock provider in the verify sandbox");
    await chooseDefault(community);
    const myChat = await sendChat(community, "[qa:plain] Say pong for the Community browser check.");
    const adminModels = await community.request.get(`${origin}/api/connections/${shared[0].id}/models`);
    step("Community member can chat on their own connection and cannot use the admin connection", adminModels.status() === 404);

    await page.goto(`${origin}/admin`);
    await hostingMode("Team");
    const reopened = await community.goto(`${origin}${myChat}`);
    assert.equal(reopened?.status(), 200, "saved chat remains open when the connection owner changes");
    await community.goto(`${origin}/settings`);
    await chooseDefault(community);
    await community.goto(`${origin}${myChat}`);
    assert.equal(await sendChat(community, "[qa:plain] Use Team for the saved Community chat."), myChat);
    step("Community to Team can continue an existing chat using the member's new Team default", true);
  } finally {
    try {
      for (const account of await accountsList()) {
        if (![teamEmail, communityEmail].includes(account.email)) continue;
        assert.equal((await request.delete(`${usersUrl}/${account.id}`)).status(), 200, "delete only the synthetic users made by this scenario");
      }
      for (const invite of await invites()) {
        assert.equal((await request.delete(`${invitesUrl}/${invite.id}`)).status(), 200, "revoke pending fixture invites");
      }
      const restored = await request.put(adminSettings, { data: { hostingMode: "personal" } });
      step("Accounts leaves one admin and restores Personal", restored.ok() && (await accountsList()).length === 1 && (await getJSON(adminSettings)).hostingMode === "personal");
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }

  async function selectSignupOpen() {
    await heading(page, "Signup").waitFor();
    const saved = apiResponse(page, "/api/admin/settings", "PUT");
    await select(page, "Signup mode", "Open");
    assert.equal((await saved).status(), 200, "open Community signup");
  }
}
