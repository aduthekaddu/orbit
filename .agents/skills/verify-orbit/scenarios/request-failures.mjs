import { eventually } from "../../../../src/lib/eventually.mjs";
import { settingsForm, settingsSave } from "../../../../scripts/qa/settings-save.mjs";

// Fails each browser request with page.route and checks what the screen shows.

const shows = (locator, timeout = 5_000) => locator.waitFor({ timeout }).then(() => true, () => false);
// locator.waitFor only accepts attached, detached, visible, or hidden. Wait for isDisabled().
const disabled = (locator, timeoutMs = 5_000) =>
  eventually(() => locator.isDisabled(), (isDisabled) => isDisabled, { timeoutMs, what: "the control to be disabled" }).then(() => true, () => false);

export default async function requestFailures({ page, origin, step, shot }) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const created = await page.request.post(`${origin}/api/chats`);
  const { id } = await created.json();
  const chatUrl = `${origin}/c/${id}`;

  // New chat opens a draft at /new and sends no request, so it has no failure to show. chat-manage covers drafts.
  const saveButton = settingsSave(page);

  const failedLabel = page.getByText("Failed", { exact: true }).first();
  const zeroModels = page.getByText(/^\s*0\s+models?\s*$/).first();
  const someModels = page.getByText(/^\s*\d+\s+models?\s*$/).first();
  const modelList = "**/api/connections/*/models";

  await page.route(modelList, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>gateway</html>" }));
  await page.goto(`${origin}/settings`);
  const unreadable = await shows(failedLabel, 10_000);
  await shot("models-unreadable");
  step("a model list that is not JSON shows Failed, not 0 models", unreadable && !(await zeroModels.isVisible()), unreadable ? "0 models is visible" : "no Failed label");

  for (const [label, body, contentType] of [
    ["a bad request", '{"error":"Invalid model request"}', "application/json"],
    ["a proxy", "<html>400 Bad Request</html>", "text/html"],
  ]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route(modelList, (route) => route.fulfill({ status: 400, contentType, body }));
    await page.reload();
    step(`a model list 400 from ${label} shows Failed, not Not checked`, await shows(failedLabel, 10_000), "no Failed label");
  }

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(modelList, (route) => route.abort());
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
  await saveButton.click();
  const savePending = await disabled(saveButton);
  await settingsForm(page).evaluate((form) => form.requestSubmit());
  const saveRequests = heldSaves.length;
  await Promise.all(heldSaves.splice(0).map((route) => route.continue().catch(() => {})));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  step("a second Settings Save while one is pending does not start another request", savePending && saveRequests === 1, `pending ${savePending}, PUTs ${saveRequests}`);
  await shot("settings-save-held");

  await page.route("**/api/settings", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await saveButton.click();
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
  await editor.fill("");
  const save = page.getByRole("button", { name: "Save", exact: true });
  step("Save is disabled while the reply is blank", await save.isDisabled(), "Save is enabled");
  await editor.fill("pong, edited");
  await page.route("**/api/chats/*/messages/*", (route) => route.abort());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const editFailed = await shows(page.getByText("Could not save", { exact: true }));
  await shot("reply-edit-offline");
  step("a reply edit that fails on the network shows Could not save and keeps the editor", editFailed && (await editor.isVisible()), editFailed ? "the editor closed" : "no Could not save");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  step("no failed request raised a page error", pageErrors.length === 0, pageErrors.join("; "));
}
