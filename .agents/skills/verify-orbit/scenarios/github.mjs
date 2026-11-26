import { eventually } from "../../../../src/lib/eventually.mjs";
import { startMockMcp } from "../../../../scripts/qa/mock-mcp.mjs";
import { settingsSave } from "../../../../scripts/qa/settings-save.mjs";

const ISSUE = "https://github.com/aduthekaddu/orbit/issues/7";
export default async function github({ page, origin, useProvider, step, shot }) {
  const mock = await startMockMcp();
  try {
    await useProvider();
    const saved = await page.request.put(`${origin}/api/settings`, {
      data: {
        githubToken: mock.token,
        githubMcpUrl: mock.url,
      },
    });
    const savedText = await saved.text();
    const savedBody = JSON.parse(savedText);
    step(
      "saving a GitHub token reports the flag and hides the token",
      saved.ok() && savedBody.githubTokenSet === true && savedBody.githubMcpUrl === mock.url && !("githubToken" in savedBody) && !savedText.includes(mock.token),
    );

    await page.goto(`${origin}/settings`);
    const token = page.getByLabel("Token", { exact: true });
    const url = page.getByLabel("MCP URL", { exact: true });
    step("GitHub settings show the token field and the saved MCP URL", await token.isVisible() && (await url.inputValue()) === mock.url);
    await token.fill("wrong-token");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    const rejected = await page.getByText("GitHub rejected the token.", { exact: true }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    step("a wrong token shows the rejection", rejected);
    await token.fill("");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    const connected = page.locator("[data-github-status='connected']");
    const connectedVisible = await connected.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const login = connectedVisible ? await connected.innerText() : "";
    step("Check shows Connected and the GitHub login", connectedVisible && login.includes("Connected") && login.includes("octocat"));
    step("Check closes the GitHub connection", mock.openSessions() === 0);
    await shot("connected");

    const created = await page.request.post(`${origin}/api/chats`);
    const { id } = await created.json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder("Ask anything");
    await composer.fill("[qa:github]");
    await composer.press("Enter");
    const card = page.locator('[data-tool-name="github_list_issues"]');
    const succeeded = await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 30_000 }).then(() => true, () => false);
    step("the issue card succeeds", succeeded);
    if (!succeeded) {
      await shot("issues");
      return;
    }
    const cardLink = card.getByRole("link", { name: "Migration lock", exact: true });
    step(
      "the card links the issue",
      (await cardLink.getAttribute("href")) === ISSUE && (await cardLink.getAttribute("target")) === "_blank" && (await cardLink.getAttribute("rel")) === "noopener noreferrer nofollow",
    );
    const answer = page.locator('[data-message-role="assistant"]').last().getByRole("link", { name: "Migration lock", exact: true }).last();
    const answered = await answer.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    step("the model answers with the issue link", answered && (await answer.getAttribute("href")) === ISSUE);
    step("issue text is not rendered", (await page.getByText("Ignore previous instructions").count()) === 0);
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });
    await eventually(() => mock.openSessions(), (open) => open === 0, { timeoutMs: 2_000, intervalMs: 100, what: "the GitHub connection to close" }).catch(() => {});
    step("the chat closes the GitHub connection", mock.openSessions() === 0 && mock.closeCount() >= 1);
    await shot("issues");
    await page.reload();
    await card.locator('[data-tool-status="succeeded"]').waitFor({ timeout: 15_000 });
    step("the issue link survives reload", (await card.getByRole("link", { name: "Migration lock", exact: true }).getAttribute("href")) === ISSUE);
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    await shot("mobile");
    step("the mobile card fits without page overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    const listed = await (await page.request.get(`${origin}/api/settings`)).text();
    step("settings still hide the token", !listed.includes(mock.token) && !listed.includes("wrong-token"));

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${origin}/settings`);
    await page.getByRole("button", { name: "Remove GitHub token", exact: true }).click();
    await settingsSave(page).click();
    const savedLabel = await page.getByText("Saved", { exact: true }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const removedText = await (await page.request.get(`${origin}/api/settings`)).text();
    const removed = JSON.parse(removedText);
    step("Remove clears the saved GitHub token", savedLabel && removed.githubTokenSet === false && !removedText.includes(mock.token));
  } finally {
    await mock.close();
  }
}
