import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const widths = [1440, 390];
const memoryId = "qa-slice-review-memory";
const date = "2099-01-01";

export default async function sliceReview({ page, origin, useProvider, step, shot }) {
  await useProvider();
  const cookies = await page.context().cookies();
  const session = await (await page.request.get(`${origin}/api/auth/get-session`)).json();
  if (!session?.user?.id) throw new Error("The review fixture requires a signed-in account.");
  const userId = session.user.id;
  const db = new Database(".verify/sandbox/data/orbit.db", { fileMustExist: true, timeout: 5_000 });
  try {
    sqliteVec.load(db);
    db.prepare("INSERT INTO memories(id, user_id, kind, text, text_norm, created_at) VALUES (?, ?, 'fact', ?, ?, ?)").run(
      memoryId, userId, "Review fixture memory", "review fixture memory", Date.now(),
    );
    db.prepare(`INSERT INTO memory_runs
      (user_id, date, state, started_at, finished_at, chat_ids, done_chat_ids, retry_chat_ids, added, merged, error)
      VALUES (?, ?, 'failed', ?, ?, '[]', '[]', '[]', 0, 0, 'Dream failed')`).run(userId, date, Date.now() - 1000, Date.now());

    for (const width of widths) {
      const touch = width === 390;
      const context = await page.context().browser().newContext({
        viewport: { width, height: touch ? 844 : 900 }, hasTouch: touch, isMobile: touch,
      });
      await context.addCookies(cookies);
      const view = await context.newPage();
      const report = (name, okay, detail) => step(`${width}: ${name}`, okay, detail);
      const composer = view.getByPlaceholder("Ask anything");
      const skip = view.locator('a[href="#content"]');
      const search = view.getByRole("dialog", { name: "Command palette" });

      async function newChat() {
        const response = await view.request.post(`${origin}/api/chats`);
        if (!response.ok()) throw new Error(`New chat returned ${response.status()}`);
        return (await response.json()).id;
      }

      async function sidebar() {
        if (!touch) return view.locator("aside").first();
        const drawer = view.getByRole("dialog", { name: "Chats" });
        if (!(await drawer.isVisible())) await view.getByRole("button", { name: "Open sidebar" }).click();
        return drawer;
      }

      async function removeAction(id) {
        const link = (await sidebar()).locator(`a[href="/c/${id}"]`);
        if (!touch) await link.hover();
        await link.locator("..").getByRole("button", { name: /^Actions for / }).click();
        return view.getByRole("menuitem", { name: "Delete" });
      }

      async function remove(id) {
        await (await removeAction(id)).click();
      }

      async function check(name, work) {
        try {
          await work();
        } catch (error) {
          report(name, false, String(error).split("\n")[0]);
        }
      }

      try {
        const chat = await newChat();
        await view.goto(`${origin}/c/${chat}`);
        await composer.fill("[qa:plain] Status row_id with columns and labels.");
        await composer.press("Enter");
        const reply = view.locator('[data-message-role="assistant"]').last();
        await reply.waitFor({ timeout: 15_000 });
        await view.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 15_000 });

        await check("skip with the chat editor open", async () => {
          if (!touch) await reply.hover();
          await reply.getByRole("button", { name: "Edit reply" }).click();
          await view.getByRole("textbox", { name: "Edit reply" }).waitFor();
          await skip.focus();
          await skip.press("Enter");
          const focused = await composer.evaluate((element) => element === document.activeElement);
          report("Skip to chat focuses the composer with Edit reply open", focused);
          await shot(`chat-focus-${width}`, view);
        });

        await check("history search renders identifiers", async () => {
          await view.keyboard.press("Control+K");
          await search.getByRole("combobox").fill("columns");
          const row = search.locator('[role="option"]').filter({ hasText: "Status" }).first();
          await row.waitFor({ timeout: 10_000 });
          report("the palette preserves the identifier and marks the matching word",
            (await row.innerText()).includes("row_id") && await row.locator("mark").innerText() === "columns");
          await shot(`search-${width}`, view);
          await view.keyboard.press("Escape");
        });

        await check("memory focus and dream status", async () => {
          await view.goto(`${origin}/memory`);
          const status = view.getByText(/^Dream failed /).first();
          await status.waitFor();
          const label = await status.innerText();
          report("the generic dream failure is shown once", label.match(/Dream failed/g)?.length === 1);
          const row = view.locator("li").filter({ hasText: "Review fixture memory" });
          await row.getByRole("button", { name: "Edit" }).click();
          await view.getByRole("textbox", { name: "Memory" }).waitFor();
          await skip.focus();
          await skip.press("Enter");
          report("Skip to content focuses main with the memory editor open",
            await view.locator("#content").evaluate((element) => element === document.activeElement));
          await shot(`memory-${width}`, view);
        });

        await check("Undo immediately followed by pagehide", async () => {
          await view.goto(`${origin}/settings`);
          const id = await newChat();
          await view.reload();
          await view.route(`**/api/chats/${id}`, (route) => route.request().method() === "DELETE"
            ? route.fulfill({ status: 204 }) : route.fallback());
          await remove(id);
          const undo = view.getByRole("button", { name: "Undo" });
          await undo.waitFor();
          const sends = await undo.evaluate((button, path) => {
            const original = window.fetch;
            let deletes = 0;
            window.fetch = (input, init) => {
              if (String(input).endsWith(path) && init?.method === "DELETE") deletes++;
              return original(input, init);
            };
            try {
              document.addEventListener("click", () => window.dispatchEvent(new PageTransitionEvent("pagehide")), { once: true });
              button.click();
              return deletes;
            } finally {
              window.fetch = original;
            }
          }, `/api/chats/${id}`);
          report("pagehide in the Undo click leaves the row and sends no DELETE",
            sends === 0 && await (await sidebar()).locator(`a[href="/c/${id}"]`).isVisible(), `DELETEs ${sends}`);
          await view.unroute(`**/api/chats/${id}`);
        });

        await check("pagehide commits the displaced and newly pending deletes", async () => {
          await view.goto(`${origin}/settings`);
          const earlier = await newChat();
          const latest = await newChat();
          await view.reload();
          await remove(earlier);
          const action = await removeAction(latest);
          const sends = await action.evaluate((button, ids) => {
            const fetch = window.fetch;
            const current = [];
            window.fetch = (input, init) => {
              const id = String(input).split("/").at(-1);
              if (init?.method !== "DELETE" || !ids.includes(id)) return fetch(input, init);
              current.push(id);
              return Promise.resolve(new Response(null, { status: 204 }));
            };
            document.addEventListener("click", () => window.dispatchEvent(new PageTransitionEvent("pagehide")), { once: true });
            button.click();
            return [...current];
          }, [earlier, latest]);
          report("the delete click sends both queued deletes before pagehide returns",
            sends.filter((id) => id === earlier).length === 1 && sends.filter((id) => id === latest).length === 1,
            `earlier ${sends.includes(earlier)}, latest ${sends.includes(latest)}, total ${sends.length}`);
        });

        await check("sign out waits for deletes and reports a failure", async () => {
          await view.goto(`${origin}/settings`);
          const first = await newChat();
          const last = await newChat();
          await view.reload();
          const seen = new Map();
          let signOuts = 0;
          const releaseFirst = Promise.withResolvers();
          await view.route("**/api/chats/*", async (route) => {
            const id = new URL(route.request().url()).pathname.split("/").at(-1);
            if (route.request().method() !== "DELETE" || (id !== first && id !== last)) return route.fallback();
            seen.set(id, (seen.get(id) ?? 0) + 1);
            if (id === first) {
              await releaseFirst.promise;
              return route.fulfill({ status: 204 });
            }
            await route.fulfill({ status: 500, json: { error: "Fixture failure" } });
          });
          await view.route("**/api/auth/sign-out", async (route) => {
            signOuts++;
            await route.fulfill({ status: 500, json: { error: "Fixture guard" } });
          });
          try {
            await remove(first);
            await remove(last);
            await (await sidebar()).getByRole("button", { name: "Sign out" }).click();
            const dialog = view.getByRole("dialog", { name: "Sign out?" });
            await Promise.all([
              view.waitForRequest((request) => request.method() === "DELETE" && request.url().endsWith(`/api/chats/${last}`), { timeout: 8_000 }),
              dialog.getByRole("button", { name: "Sign out" }).click(),
            ]);
            report("sign out waits for the earlier in-flight delete", signOuts === 0 && seen.get(first) === 1);
            releaseFirst.resolve();
            const alert = dialog.getByRole("alert");
            await alert.waitFor({ timeout: 8_000 });
            report("delete failure stays in the sign-out dialog and keeps the session",
              (await alert.innerText()).includes("Could not delete") && signOuts === 0,
              `sign-out requests ${signOuts}, alert ${await alert.innerText()}`);
            report("each queued delete sends exactly once", seen.get(first) === 1 && seen.get(last) === 1,
              `earlier ${seen.get(first)}, last ${seen.get(last)}`);
            await shot(`sign-out-${width}`, view);
          } finally {
            releaseFirst.resolve();
          }
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    try {
      db.prepare("DELETE FROM memory_runs WHERE user_id = ? AND date = ?").run(userId, date);
      db.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?").run(userId, memoryId);
    } finally {
      db.close();
    }
  }
}
