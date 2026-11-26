import assert from "node:assert/strict";
import { startMockSearxng } from "../../../../scripts/qa/mock-searxng.mjs";

export default async function searchFinalUi({ page, origin, useProvider, step, shot }) {
  const mock = await startMockSearxng();
  try {
    await useProvider();
    const saved = await page.request.put(`${origin}/api/settings`, { data: { searxngUrl: mock.url, tavilyApiKey: null } });
    assert.equal(saved.status(), 200);
    for (const kind of ["card", "artifact"]) {
      const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
      await page.goto(`${origin}/c/${id}`);
      const composer = page.getByPlaceholder("Ask anything");
      await composer.fill(`[qa:search-loop] orbit ${kind}`);
      await composer.press("Enter");
      const reply = page.locator('[data-message-role="assistant"]').last();
      await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 20_000 });
      const chat = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
      const parts = chat.messages.flatMap(({ message }) => message.role === "assistant" ? message.parts : []);
      step(`${kind} uses four searches and five model steps`, parts.filter((part) => part.type === "tool-web_search").length === 4 && parts.filter((part) => part.type === "step-start").length === 5);
      if (kind === "card") {
        step("the final step renders the requested card", parts.some((part) => part.type === "tool-render_ui" && part.state === "output-available") && await reply.getByText("Researched orbit", { exact: true }).count() > 0);
      } else {
        step("the final step keeps artifact instructions", parts.some((part) => part.type === "text" && part.text.includes("```html\n<h1>Researched orbit</h1>")));
      }
      await shot(`${kind}-final`);
      await page.reload();
      await page.locator('[data-message-role="assistant"]').last().getByRole("button", { name: "Regenerate", exact: true }).waitFor();
      if (kind === "card") step("the researched card survives reload", await page.getByText("Researched orbit", { exact: true }).count() > 0);
      else step("the researched artifact survives reload", await page.getByRole("button", { name: "Preview", exact: true }).count() > 0);
      await shot(`${kind}-reloaded`);
    }
  } finally {
    await mock.close();
  }
}
