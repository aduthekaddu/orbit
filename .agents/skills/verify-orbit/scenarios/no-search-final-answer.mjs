import assert from "node:assert/strict";

const answer = "Answered after four notes.";

export default async function noSearchFinalAnswer({ page, origin, useProvider, step, shot }) {
  await useProvider();
  const saved = await page.request.put(`${origin}/api/admin/settings`, { data: { searxngUrl: "", tavilyApiKey: null } });
  assert.equal(saved.status(), 200);
  const settings = await (await page.request.get(`${origin}/api/admin/settings`)).json();
  step("search is off", settings.searxngUrl === "" && settings.tavilyKeySet === false);
  try {
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder("Ask anything");
    await composer.fill("[qa:remember-loop] keep notes");
    await composer.press("Enter");
    const reply = page.locator('[data-message-role="assistant"]').last();
    await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 30_000 });
    // Regenerate can show as soon as the run is no longer marked running, which can be a
    // moment before the last text part is in the reply. The saved chat may already have the
    // answer then. Wait for the answer itself; do not sample the DOM once.
    const answerOnScreen = reply.getByText(answer, { exact: true });
    const sawAnswer = await answerOnScreen.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const chat = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    const parts = chat.messages.flatMap(({ message }) => message.role === "assistant" ? message.parts : []);
    const notes = parts.filter((part) => part.type === "tool-remember").length;
    const steps = parts.filter((part) => part.type === "step-start").length;
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    step("four remember calls use four of the five model steps", notes === 4 && steps === 5, `remember=${notes} steps=${steps}`);
    step("the fifth step answers in text", text === answer && sawAnswer, `text=${JSON.stringify(text)}`);
    await shot("final-answer");
    await page.reload();
    await page.locator('[data-message-role="assistant"]').last().getByRole("button", { name: "Regenerate", exact: true }).waitFor();
    step("the answer survives reload", await page.getByText(answer, { exact: true }).count() > 0);
    await shot("reloaded");
  } finally {
    const { memories } = await (await page.request.get(`${origin}/api/memories?q=${encodeURIComponent("Loop note")}`)).json();
    for (const memory of memories.filter((entry) => /^Loop note \d+$/.test(entry.text))) {
      await page.request.delete(`${origin}/api/memories/${memory.id}`);
    }
  }
}
