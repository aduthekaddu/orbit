// Fails each browser request with page.route and checks what the screen shows.
const shows = (locator, timeout = 5_000) => locator.waitFor({ timeout }).then(() => true, () => false);

export default async function requestFailures({ page, origin, step, shot }) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  const chatUrl = `${origin}/c/${id}`;
  await page.goto(chatUrl);
  await page.getByRole("textbox").waitFor({ timeout: 10_000 });

  const newChat = page.getByRole("button", { name: "New chat" }).locator("visible=true").first();
  const newChatError = page.getByRole("alert").filter({ hasText: "Could not create chat" });
  let posts = 0;
  async function failNewChat(answer) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/chats", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      return answer(route);
    });
  }

  await failNewChat((route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await newChat.click();
  const serverError = await shows(newChatError);
  await shot("new-chat-500");
  step("New chat that gets a 500 shows Could not create chat", serverError && page.url() === chatUrl, `alert ${serverError}, url ${page.url()}`);

  await failNewChat((route) => route.abort());
  await newChat.click();
  const offline = await shows(newChatError);
  step("New chat that fails on the network shows Could not create chat", offline && page.url() === chatUrl, `alert ${offline}, url ${page.url()}`);

  await failNewChat((route) => route.fulfill({ status: 201, contentType: "application/json", body: "{}" }));
  await newChat.click();
  const invalid = await shows(newChatError);
  await page.waitForTimeout(500);
  step("New chat that gets a body with no id shows Could not create chat and stays put", invalid && page.url() === chatUrl, `alert ${invalid}, url ${page.url()}`);

  // Radix hides the page behind an open modal from screen readers, so the alert must sit inside the drawer.
  await newChatError.waitFor({ state: "hidden", timeout: 6_000 }).catch(() => {});
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await failNewChat((route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Chats" });
  await drawer.getByRole("button", { name: "New chat" }).click();
  const announced = await shows(newChatError);
  await shot("new-chat-drawer-500");
  step("New chat that fails from the open mobile drawer shows Could not create chat to screen readers", announced && (await drawer.isVisible()), `alert ${announced}`);
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden", timeout: 5_000 });
  await page.setViewportSize(desktop);

  posts = 0;
  await failNewChat(async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue().catch(() => {});
  });
  await newChat.dblclick();
  await page.keyboard.press("Control+Shift+O");
  const moved = await page.waitForURL((url) => url.pathname.startsWith("/c/") && url.href !== chatUrl, { timeout: 10_000 }).then(() => true, () => false);
  await page.waitForTimeout(500);
  await shot("new-chat-recovered");
  step("a double click and the shortcut during one pending New chat send one request, then open the chat", moved && posts === 1 && !(await newChatError.isVisible()), `moved ${moved}, ${posts} POSTs`);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  const heldCreates = [];
  await page.route("**/api/chats", (route) => {
    if (route.request().method() === "POST") heldCreates.push(route);
    else route.continue();
  });
  await newChat.click();
  const sawPending = await newChat.waitFor({ state: "disabled", timeout: 5_000 }).then(() => true, () => false);
  await page.goto(`${origin}/settings`);
  await page.getByRole("button", { name: "Save", exact: true }).waitFor({ timeout: 10_000 });
  await Promise.all(heldCreates.splice(0).map((route) => route.continue().catch(() => {})));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const leftSettings = await page.waitForURL((url) => !url.pathname.startsWith("/settings"), { timeout: 2_000 }).then(() => true, () => false);
  step("a New chat answer that arrives after opening Settings leaves Settings open", sawPending && !leftSettings, `pending ${sawPending}, left ${leftSettings}, url ${page.url()}`);
  await shot("new-chat-after-leave");

  const status = page.locator("form").first();
  const failedLabel = status.getByText("Failed", { exact: true });
  const zeroModels = status.getByText(/^\s*0\s+models?\s*$/);
  const someModels = status.getByText(/^\s*\d+\s+models?\s*$/);

  await page.route("**/api/models", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>gateway</html>" }));
  await page.goto(`${origin}/settings`);
  const unreadable = await shows(failedLabel, 10_000);
  await shot("models-unreadable");
  step("a model list that is not JSON shows Failed, not 0 models", unreadable && !(await zeroModels.isVisible()), unreadable ? "0 models is visible" : "no Failed label");

  for (const [label, body, contentType] of [
    ["a bad request", '{"error":"Invalid model request"}', "application/json"],
    ["a proxy", "<html>400 Bad Request</html>", "text/html"],
  ]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/models", (route) => route.fulfill({ status: 400, contentType, body }));
    await page.reload();
    step(`a model list 400 from ${label} shows Failed, not Not checked`, await shows(failedLabel, 10_000), `status ${await status.locator("[aria-live]").first().textContent()}`);
  }

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/models", (route) => route.abort());
  await page.reload();
  step("a model list that fails on the network shows Failed", await shows(failedLabel, 10_000), "no Failed label");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const listed = await shows(someModels, 10_000);
  step("a model list that loads shows its count", listed && !(await failedLabel.isVisible()), listed ? "Failed is visible" : "no model count");

  const heldSaves = [];
  await page.route("**/api/settings", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    heldSaves.push(route);
  });
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await saveButton.click();
  const savePending = await saveButton.waitFor({ state: "disabled", timeout: 5_000 }).then(() => true, () => false);
  await page.locator("form").first().evaluate((form) => form.requestSubmit());
  const saveRequests = heldSaves.length;
  await Promise.all(heldSaves.splice(0).map((route) => route.continue().catch(() => {})));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  step("a second Settings Save while one is pending does not start another request", savePending && saveRequests === 1, `pending ${savePending}, PUTs ${saveRequests}`);
  await shot("settings-save-held");

  await page.route("**/api/settings", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saveFailed = await shows(page.getByRole("alert").filter({ hasText: "Could not save" }));
  await shot("settings-save-offline");
  step("a settings save that fails on the network shows Could not save", saveFailed, "no Could not save");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  const github = page.locator("[data-github-status]");
  await page.route("**/api/settings/github/check", (route) => route.abort());
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const githubOffline = await shows(github.getByText("GitHub is unavailable.", { exact: true }));
  step("a GitHub check that fails on the network says GitHub is unavailable.", githubOffline, `status ${await github.textContent().catch(() => "none")}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/settings/github/check", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: '{"ok":false,"error":"Check the GitHub URL."}' }),
  );
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const githubRejected = await shows(github.getByText("Check the GitHub URL.", { exact: true }));
  await shot("github-check-400");
  step("a GitHub check that gets a 400 shows the server's error", githubRejected, `status ${await github.textContent().catch(() => "none")}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await page.goto(chatUrl);
  const composer = page.getByRole("textbox");
  await composer.fill("[qa:plain] edit me");
  await composer.press("Enter");
  const reply = page.locator('[data-message-role="assistant"]').last();
  const replied = await shows(reply.getByText("pong", { exact: true }), 30_000);
  step("the chat has a reply to edit", replied, "no pong");
  await reply.hover();
  await page.getByRole("button", { name: "Edit reply" }).last().click();
  const editor = page.getByRole("textbox", { name: "Edit reply" });
  await editor.fill("pong, edited");
  await page.route("**/api/chats/*/messages/*", (route) => route.abort());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const editFailed = await shows(page.getByText("Could not save", { exact: true }));
  await shot("reply-edit-offline");
  step("a reply edit that fails on the network shows Could not save and keeps the editor", editFailed && (await editor.isVisible()), editFailed ? "the editor closed" : "no Could not save");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  step("no failed request raised a page error", pageErrors.length === 0, pageErrors.join("; "));
}
