import { eventually } from "../../../../src/lib/eventually.mjs";

export default async function deleteCompat({ page, origin, step, shot }) {
  const cookies = await page.context().cookies();

  for (const width of [1440, 390]) {
    const phone = width === 390;
    const context = await page.context().browser().newContext({
      viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone,
    });
    await context.addCookies(cookies);
    await context.addInitScript(() => Reflect.deleteProperty(Promise, "withResolvers"));
    const view = await context.newPage();
    const errors = [];
    view.on("pageerror", (error) => errors.push(error.message));
    const report = (name, ok, detail) => step(`${width}: ${name}`, ok, detail);

    try {
      const created = await view.request.post(`${origin}/api/chats`);
      if (!created.ok()) throw new Error(`Create chat returned ${created.status()}`);
      const { id } = await created.json();
      const url = `${origin}/api/chats/${id}`;
      await view.goto(`${origin}/settings`);
      if (phone) await view.getByRole("button", { name: "Open sidebar" }).click();
      const sidebar = phone ? view.getByRole("dialog", { name: "Chats" }) : view.locator("aside").first();
      const row = sidebar.locator(`a[href="/c/${id}"]`);
      if (!phone) await row.hover();
      await row.locator("..").getByRole("button", { name: /^Actions for / }).click();
      const remove = view.getByRole("menuitem", { name: "Delete" });
      await remove.waitFor();
      report("the app is interactive while Promise.withResolvers is unavailable",
        await view.evaluate(() => typeof Promise.withResolvers === "undefined"));

      const first = Promise.withResolvers();
      const release = Promise.withResolvers();
      let requests = 0;
      await view.route(`**/api/chats/${id}`, async (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        requests++;
        first.resolve();
        await release.promise;
        return route.continue();
      });
      try {
        await remove.click();
        await view.getByRole("button", { name: "Undo" }).waitFor();
        // A pagehide delivered twice while the first request is held must reuse the registered request.
        const departing = () => view.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
        await departing();
        const started = await eventually(() => requests > 0 || errors.length > 0, Boolean, {
          timeoutMs: 4_000, what: "the delete request or a browser exception",
        }).catch(() => false);
        if (started && requests > 0) {
          await first.promise;
          await departing();
        }
        release.resolve();
        const status = await eventually(async () => (await view.request.get(url)).status(),
          (code) => code === 404, { timeoutMs: 4_000, what: "the saved chat to be gone" })
          .catch(async () => (await view.request.get(url)).status());
        report("pending Delete reaches the server and removes the chat", status === 404,
          `GET status ${status}, DELETE requests ${requests}`);
        report("repeated pagehide sends exactly one DELETE with no page error",
          requests === 1 && errors.length === 0, `DELETE requests ${requests}, errors ${errors.join(", ")}`);
        await shot(`delete-compat-${width}`, view);
      } finally {
        release.resolve();
      }
    } finally {
      await context.close();
    }
  }
}
