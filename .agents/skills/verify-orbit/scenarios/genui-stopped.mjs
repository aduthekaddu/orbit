export default async function genuiStopped({ page, origin, step, shot }) {
  const response = await page.request.post(`${origin}/api/chats`);
  if (!response.ok()) throw new Error(`could not create the test chat (${response.status()})`);
  const { id } = await response.json();
  await page.goto(`${origin}/c/${id}`);

  const composer = page.getByPlaceholder("Ask anything");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const card = page.locator('[data-tool-name="render_ui"]');
  const firstCard = card.first();
  const fallback = firstCard.locator("[data-genui-fallback]").first();

  async function expectStopped(label) {
    await fallback.waitFor({ timeout: 20_000 });
    const cardCount = await card.count();
    const snapshot = await firstCard.evaluate((node) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      document.body.append(probe);
      const mutedColor = getComputedStyle(probe).color;
      probe.remove();

      const statusNode = node.querySelector("[data-tool-status]");
      const fallbacks = [...node.querySelectorAll("[data-genui-fallback]")];
      const fallbackNode = fallbacks[0] ?? null;
      return {
        statusAttr: statusNode?.getAttribute("data-tool-status") ?? "",
        statusText: statusNode?.textContent?.trim() ?? "",
        statusMuted: statusNode ? getComputedStyle(statusNode).color === mutedColor : false,
        fallbackCount: fallbacks.length,
        fallbackText: fallbackNode?.textContent?.trim() ?? "",
        fallbackMuted: fallbackNode ? getComputedStyle(fallbackNode).color === mutedColor : false,
        rawCount: node.querySelectorAll("pre, details").length,
        cardText: node.innerText.replace(/\s+/g, " ").trim(),
      };
    });
    const ok =
      cardCount === 1 &&
      snapshot.statusAttr === "cancelled" &&
      snapshot.statusText === "Cancelled" &&
      snapshot.statusMuted &&
      snapshot.fallbackCount === 1 &&
      snapshot.fallbackText === "Stopped" &&
      snapshot.fallbackMuted &&
      snapshot.rawCount === 0 &&
      snapshot.cardText === "Generated UI Cancelled Stopped";
    step(
      label,
      ok,
      `cards=${cardCount} status=${snapshot.statusAttr}/${snapshot.statusText} statusMuted=${snapshot.statusMuted} fallbacks=${snapshot.fallbackCount} fallbackText=${JSON.stringify(snapshot.fallbackText)} fallbackMuted=${snapshot.fallbackMuted} raw=${snapshot.rawCount} text=${JSON.stringify(snapshot.cardText)}`,
    );
  }

  await composer.fill("[qa:truncated] Render a stream that stops.");
  await composer.press("Enter");
  await fallback.waitFor({ timeout: 25_000 });
  await stop.waitFor({ state: "hidden", timeout: 25_000 });
  await expectStopped("interrupted render_ui shows Cancelled and one muted Stopped line with no raw details");
  await shot("at-interruption");

  await composer.fill("[qa:recover] Try a plain reply after the truncated stream.");
  await composer.press("Enter");
  const recovered = page.getByText("Recovered after the failed stream.", { exact: true });
  await recovered.waitFor({ timeout: 25_000 });
  await stop.waitFor({ state: "hidden", timeout: 25_000 });
  await expectStopped("follow-up preserves Cancelled and one muted Stopped line with no raw details");
  await shot("after-follow-up");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stored = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    const assistants = Array.isArray(stored.messages)
      ? stored.messages.filter(({ message }) => message?.role === "assistant").length
      : 0;
    if (assistants >= 2) break;
    await page.waitForTimeout(250);
  }

  await page.reload();
  await recovered.waitFor({ timeout: 20_000 });
  await expectStopped("reload preserves Cancelled and one muted Stopped line with no raw details");
  const assistants = await page.locator('[data-message-role="assistant"]').count();
  step("reload keeps both assistant turns", assistants === 2, `found ${assistants} assistant message(s)`);
  await shot("after-reload");
}
